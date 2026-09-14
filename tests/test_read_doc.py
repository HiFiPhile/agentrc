"""Tests for the read-doc skill's search.py and locate.py: metadata search
ranks the authoritative document kinds first, the page index stays paired with
the PDF it came from, page numbers are the physical ones a reader opens, and
every refusal is explicit rather than a silent default."""
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'skills' / 'read-doc' / 'scripts'
FIXTURE = ROOT / 'tests' / 'data' / 'three-pages.pdf'
sys.path.insert(0, str(SCRIPTS))
import search  # noqa: E402
import locate  # noqa: E402

SCHEMA = """
CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT);
CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT, uncompressed_size INTEGER);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
"""


def fake_library(tmp, books):
    """A Calibre-shaped library: books is [(id, title, [tags], has_pdf)]."""
    db = sqlite3.connect(os.path.join(tmp, 'metadata.db'))
    db.executescript(SCHEMA)
    for bid, title, tags, has_pdf in books:
        path = f'Vendor/{title} ({bid})'
        db.execute('INSERT INTO books (id, title, path) VALUES (?,?,?)', (bid, title, path))
        if has_pdf:
            os.makedirs(os.path.join(tmp, path), exist_ok=True)
            db.execute('INSERT INTO data (book, format, name) VALUES (?,?,?)', (bid, 'PDF', title))
        for tag in tags:
            row = db.execute('SELECT id FROM tags WHERE name = ?', (tag,)).fetchone()
            tid = row[0] if row else db.execute('INSERT INTO tags (name) VALUES (?)', (tag,)).lastrowid
            db.execute('INSERT INTO books_tags_link (book, tag) VALUES (?,?)', (bid, tid))
    db.commit()
    return db


class Pages(unittest.TestCase):
    def test_a_trailing_form_feed_does_not_invent_a_page(self):
        self.assertEqual(len(locate.split_pages('one\fCtwo\f')), 2)
        self.assertEqual(len(locate.split_pages('one\ftwo')), 2, 'nor does its absence lose one')
        self.assertEqual(locate.split_pages('one\ftwo\f')[1], 'two')

    def test_a_blank_page_keeps_its_number(self):
        pages = locate.split_pages('one\f   \fthree\f')
        self.assertEqual(len(pages), 3)
        self.assertEqual(pages[2], 'three', 'page 3 is still the third element')

    def test_a_blank_final_page_is_counted_once_not_twice(self):
        self.assertEqual(len(locate.split_pages('one\f  \f')), 2)
        self.assertEqual(len(locate.split_pages('')), 0)


class Find(unittest.TestCase):
    PAGES = ['intro mentions SIE_CTRL in passing and rambles on for quite a long line indeed',
             'blank',
             'SIE_CTRL Register\nOffset: 0x4c',
             'see the SIE_CTRL register description']

    def find(self, term='SIE_CTRL', context=1, limit=5, offset=0, max_chars=4000):
        return locate.find(self.PAGES, term, context, limit, offset, max_chars)

    def test_the_definition_page_outranks_every_mention(self):
        total, blocks = self.find()
        self.assertEqual(total, 3)
        self.assertTrue(blocks[0].startswith('p3'), blocks[0])

    def test_page_numbers_are_one_based_physical_pages(self):
        _, blocks = self.find(limit=4)
        self.assertEqual(sorted(b.split('\n')[0] for b in blocks), ['p1', 'p3', 'p4'])

    def test_matching_is_literal_and_case_insensitive(self):
        self.assertEqual(self.find(term='sie_ctrl')[0], 3)
        self.assertEqual(self.find(term='OFFSET: 0X4C')[0], 1)
        self.assertEqual(self.find(term='SIE.CTRL')[0], 0, 'a dot is a dot, not a regex')

    def test_offset_past_the_end_yields_nothing_but_still_reports_the_total(self):
        total, blocks = self.find(offset=99)
        self.assertEqual((total, blocks), (3, []))

    def test_a_first_block_over_the_cap_is_truncated_but_still_emitted(self):
        # A reference manual's lines are wider than the smallest allowed cap.
        pages = ['SIE_CTRL Register. ' + 'the width of a real manual line. ' * 8]
        for cap in (locate.MIN_CHARS, 100, 200):
            _, blocks = locate.find(pages, 'SIE_CTRL', 1, 5, 0, cap)
            self.assertEqual(len(blocks), 1, f'cap {cap}: paging must make progress')
            self.assertLessEqual(len(blocks[0]), cap, f'cap {cap} exceeded')
            self.assertTrue(blocks[0].startswith('p1'), f'cap {cap} lost the page number')
            self.assertTrue(blocks[0].endswith(locate.TRUNCATED), f'cap {cap} hid the truncation')

    def test_a_definition_line_outranks_prose_that_merely_names_the_register(self):
        # Every shape here is a real line from the library; the prose lines are
        # what used to win, sending the reader to a cross-reference.
        definitions = ['Bit 15 VTRX: USB valid transaction received',
                       '40.6.7      USB endpoint/channel n register (USB_CHEPnR)',
                       'USB: SIE_CTRL Register',
                       'ERR006223: Failure to resume from WAIT/STOP mode with power gating']
        prose = ['USB_CHEPnR register) for reception double-buffered bulk endpoints or DTOGTX (bit 6 of',
                 'controls for EP0 come from SIE_CTRL. The VTRX bit is set by hardware when a transfer',
                 'see ERR006223 for the workaround that applies to this configuration of the part']
        for definition in definitions:
            term = re.search(r'VTRX|USB_CHEPnR|SIE_CTRL|ERR006223', definition).group()
            for mention in prose:
                if term.lower() not in mention.lower():
                    continue
                self.assertGreater(locate.score(definition, term), locate.score(mention, term),
                                   f'{term}: {definition!r} must outrank {mention!r}')

    def test_a_register_heading_outranks_an_interrupt_bit_of_the_same_name(self):
        # Both are definitions; the register's own page is the one a register
        # question wants. This pair is RP2040 p405 against p414.
        heading = 'USB: BUFF_STATUS Register'
        bit_row = '4           BUFF_STATUS: Raised when any bit in BUFF_STATUS is set. Clear by clearing      RO     0x0'
        self.assertGreater(locate.score(heading, 'BUFF_STATUS'), locate.score(bit_row, 'BUFF_STATUS'))
        pages = ['x', 'y', bit_row, 'z', heading]
        _, blocks = locate.find(pages, 'BUFF_STATUS', 0, 2, 0, 4000)
        self.assertTrue(blocks[0].startswith('p5'), blocks[0])

    def test_short_prose_does_not_collect_the_heading_bonus(self):
        # Real pairs from RM0492: the prose is shorter than the heading, so
        # length alone once ranked it first.
        for term, prose, heading in (
            ('USB_CNTR', '2. Clear SUSPEN bit of USB_CNTR register.', '40.6.1          USB control register (USB_CNTR)'),
            ('USB_FNR', 'bits in the USB_FNR register.', '40.6.3          USB frame number register (USB_FNR)'),
            # A sentence that wrapped leaves a line identical to a bare heading.
            ('FLASH_NSSR', 'FLASH_NSSR register', '7.10.6          FLASH status register (FLASH_NSSR)'),
            ('FLASH_NSSR', 'the FLASH_NSSR register', '7.10.6          FLASH status register (FLASH_NSSR)'),
        ):
            self.assertGreater(locate.score(heading, term), locate.score(prose, term), term)
            _, blocks = locate.find([prose, 'x', heading], term, 0, 2, 0, 4000)
            self.assertTrue(blocks[0].startswith('p3'), f'{term}: {blocks[0]}')

    def test_a_table_of_contents_line_is_demoted_below_the_section_it_points_at(self):
        term = 'USB_CHEPnR'
        toc = '40.6.7      USB endpoint/channel n register (USB_CHEPnR) . . . . . . . . 1652'
        heading = '40.6.7      USB endpoint/channel n register (USB_CHEPnR)'
        self.assertLess(locate.score(toc, term), locate.score(heading, term))

    def test_hits_within_one_context_window_are_reported_once(self):
        pages = ['SIE_CTRL here\nand SIE_CTRL again\n\n\n\nfar below SIE_CTRL']
        total, blocks = locate.find(pages, 'SIE_CTRL', 1, 5, 0, 4000)
        self.assertEqual(total, 2, 'the adjacent pair merges, the distant one does not')
        self.assertEqual(len(blocks), 2)

    def test_context_at_a_page_edge_does_not_reach_into_another_page(self):
        _, blocks = locate.find(['a\nSIE_CTRL', 'b'], 'SIE_CTRL', 5, 5, 0, 4000)
        self.assertNotIn('b', blocks[0])


class Manifest(unittest.TestCase):
    META = {'id': 7, 'path': 'Vendor/x.pdf', 'size': 10, 'mtime_ns': 99,
            'pages': 2, 'extractor': locate.EXTRACTOR, 'version': locate.VERSION}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.index = Path(self.tmp.name)
        patched = locate.INDEX
        locate.INDEX = str(self.index)
        self.addCleanup(setattr, locate, 'INDEX', patched)
        self.src = self.index / 'x.pdf'
        self.src.write_bytes(b'0123456789')

    def meta_for_src(self, **over):
        size, mtime = locate.stat_of(self.src)
        return {**self.META, 'size': size, 'mtime_ns': mtime,
                'path': os.path.relpath(self.src, locate.LIB), **over}

    def test_a_manifest_matching_the_source_is_current(self):
        self.assertTrue(locate.is_current(self.meta_for_src(), 7, self.src))

    def test_every_recorded_field_invalidates_the_index_when_it_disagrees(self):
        for field, value in (('version', 999), ('extractor', ['pdftotext']), ('id', 8),
                             ('size', 5), ('mtime_ns', 1), ('path', 'Vendor/renamed.pdf')):
            meta = self.meta_for_src(**{field: value})
            self.assertFalse(locate.is_current(meta, 7, self.src), field)
        self.assertFalse(locate.is_current(None, 7, self.src))

    def test_a_body_that_lost_pages_is_rejected_rather_than_renumbered(self):
        (self.index / '7.txt').write_text(json.dumps({**self.META, 'pages': 5}) + '\none\ftwo\f')
        self.assertEqual(locate.read_index(7), (None, None))
        self.assertIsNotNone(locate.read_header(7), 'the header alone still reads, for the bulk check')

    def test_the_bulk_check_reads_only_the_header_not_the_pages(self):
        # A whole-file read here is what made an unchanged build re-read 3.8 GB.
        real_open = open

        class HeaderOnly:
            def __init__(self, path, *a, **kw):
                self.f = real_open(path, *a, **kw)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self.f.close()

            def readline(self):
                return self.f.readline()

            def read(self, *a):
                raise AssertionError('read_header must not read the pages')

        (self.index / '7.txt').write_text(json.dumps(self.META) + '\n' + 'x' * 5000)
        with unittest.mock.patch('builtins.open', HeaderOnly):
            self.assertEqual(locate.read_header(7)['id'], 7)
        for bad in ('', 'not json\nbody', '[1, 2]\nbody'):
            (self.index / '7.txt').write_text(bad)
            self.assertIsNone(locate.read_header(7), repr(bad))

    def test_the_manifest_is_read_from_the_same_file_as_its_pages(self):
        (self.index / '7.txt').write_text(json.dumps(self.META) + '\none\ftwo\f')
        meta, pages = locate.read_index(7)
        self.assertEqual(meta['id'], 7)
        self.assertEqual(pages, ['one', 'two'])

    def test_an_unreadable_or_headerless_index_file_is_no_index_at_all(self):
        self.assertEqual(locate.read_index(7), (None, None), 'missing file')
        (self.index / '7.txt').write_text('not json\nbody')
        self.assertEqual(locate.read_index(7), (None, None), 'bad header')
        (self.index / '7.txt').write_text('{"id": 7}')
        self.assertEqual(locate.read_index(7), (None, None), 'header with no body')
        (self.index / '7.txt').write_text('[1, 2]\nbody')
        self.assertEqual(locate.read_index(7), (None, None), 'a JSON list is not a manifest')


class Extract(unittest.TestCase):
    """The real pdftotext/pdfinfo path; a stub could not prove page numbering."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Path(self.tmp.name)
        for mod, name, value in ((locate, 'INDEX', str(self.lib / '.read-doc')),
                                 (locate, 'LIB', str(self.lib))):
            self.addCleanup(setattr, mod, name, getattr(mod, name))
            setattr(mod, name, value)
        self.src = self.lib / 'doc.pdf'
        self.src.write_bytes(FIXTURE.read_bytes())

    def test_extraction_records_the_source_and_the_physical_page_count(self):
        meta = locate.extract(4, str(self.src))
        self.assertEqual(meta['pages'], 3, 'the fixture has 3 pages, the middle one blank')
        self.assertEqual(meta['id'], 4)
        self.assertEqual(meta['path'], 'doc.pdf')
        self.assertEqual((meta['size'], meta['mtime_ns']), locate.stat_of(self.src))
        self.assertEqual(os.listdir(locate.INDEX), ['4.txt'], 'one file per book, no stray temporaries')

    def test_the_extracted_pages_are_the_pages_a_reader_would_open(self):
        locate.extract(4, str(self.src))
        _, pages = locate.read_index(4)
        self.assertEqual(len(pages), 3)
        self.assertIn('SIE_CTRL Register', pages[0])
        self.assertEqual(pages[1].strip(), '', 'page 2 of the fixture is blank')
        self.assertIn('come from SIE_CTRL', pages[2])
        total, blocks = locate.find(pages, 'SIE_CTRL', 1, 5, 0, 4000)
        self.assertEqual(total, 2, "page 3's two adjacent mentions are one excerpt")
        self.assertTrue(blocks[0].startswith('p1'), blocks[0])

    def test_a_replaced_revision_is_re_extracted_and_an_unchanged_one_is_not(self):
        locate.extract(4, str(self.src))
        self.assertTrue(locate.is_current(locate.read_header(4), 4, str(self.src)))
        os.utime(self.src, (0, 0))
        self.assertFalse(locate.is_current(locate.read_header(4), 4, str(self.src)), 'a new revision is stale')
        fresh = locate.extract(4, str(self.src))
        self.assertEqual(fresh['mtime_ns'], locate.stat_of(self.src)[1])
        self.assertTrue(locate.is_current(locate.read_header(4), 4, str(self.src)), 're-extraction heals it')

    def test_a_pdftotext_failure_is_unavailable_and_leaves_nothing_behind(self):
        self.addCleanup(setattr, locate, 'EXTRACTOR', locate.EXTRACTOR)
        locate.EXTRACTOR = ['false']  # pdfinfo still succeeds, so only pdftotext fails
        with self.assertRaises(locate.Unavailable) as e:
            locate.extract(4, str(self.src))
        self.assertIn('pdftotext exit 1', str(e.exception))
        self.assertEqual(os.listdir(locate.INDEX), [])

    def test_a_source_replaced_mid_extraction_is_refused_rather_than_indexed(self):
        real = locate.page_count

        def swap(src):
            pages = real(src)
            self.src.write_bytes(FIXTURE.read_bytes() + b'\n% touched')
            return pages
        self.addCleanup(setattr, locate, 'page_count', real)
        locate.page_count = swap
        with self.assertRaises(locate.Unavailable) as e:
            locate.extract(4, str(self.src))
        self.assertIn('changed while', str(e.exception))

    def test_a_page_count_disagreement_refuses_and_leaves_no_index_behind(self):
        self.addCleanup(setattr, locate, 'page_count', locate.page_count)
        locate.page_count = lambda src: 99
        with self.assertRaises(locate.Unavailable) as e:
            locate.extract(4, str(self.src))
        self.assertIn('pdfinfo says 99', str(e.exception))
        self.assertEqual(os.listdir(locate.INDEX), [], 'the temporary file is cleaned up')

    def test_a_file_pdfinfo_cannot_read_is_unavailable_not_silently_unverified(self):
        bad = self.lib / 'bad.pdf'
        bad.write_bytes(b'not a pdf')
        with self.assertRaises(locate.Unavailable):
            locate.page_count(str(bad))


class BuildSelection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = fake_library(self.tmp.name, [
            (1, 'RM0492', ['stm32', 'reference-manual'], True),
            (2, 'Understanding Exposure', ['photography'], True),
            (3, 'AN1234', ['This application note explains portrait mode and magazine layout'], True),
            (4, 'Gone', [], False),
        ])
        self.addCleanup(self.db.close)

    def test_a_skip_tag_matches_a_whole_tag_never_a_word_inside_an_abstract(self):
        todo, skipped = locate.wanted(self.db, locate.SKIP_TAGS)
        self.assertEqual(skipped, 1, 'only the photography book')
        self.assertEqual([bid for bid, _, _ in todo], [1, 3], 'the abstract mentioning portrait stays')

    def test_skip_tags_are_matched_after_normalising_case_and_separators(self):
        _, skipped = locate.wanted(self.db, ['PHOTO GRAPHY'])
        self.assertEqual(skipped, 0)
        _, skipped = locate.wanted(self.db, ['Photography'])
        self.assertEqual(skipped, 1)

    def test_a_book_without_a_pdf_is_refused_by_id_rather_than_silently_skipped(self):
        with self.assertRaises(locate.Unavailable):
            locate.pdf_row(self.db, 4)
        with self.assertRaises(locate.Unavailable):
            locate.pdf_row(self.db, 999)


class Prune(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = fake_library(self.tmp.name, [(1, 'Live', [], True), (2, 'NoPdf', [], False)])
        self.addCleanup(self.db.close)
        self.index = Path(self.tmp.name) / '.read-doc'
        self.index.mkdir()
        self.addCleanup(setattr, locate, 'INDEX', locate.INDEX)
        locate.INDEX = str(self.index)

    def test_it_removes_only_the_index_files_of_books_that_lost_their_pdf(self):
        for name in ('1.txt', '2.txt', '3.txt', '3.txt.tmp42'):
            (self.index / name).write_text('x')
        self.assertEqual(locate.prune(self.db), 3)
        self.assertEqual(os.listdir(self.index), ['1.txt'])

    def test_it_never_touches_a_file_it_did_not_write(self):
        keep = ('3.notes', 'README', '3', 'x3.txt', '3.txt.bak')
        for name in keep:
            (self.index / name).write_text('x')
        (self.index / '3.dir').mkdir()
        self.assertEqual(locate.prune(self.db), 0)
        self.assertEqual(sorted(os.listdir(self.index)), sorted([*keep, '3.dir']))


class BuildEndToEnd(unittest.TestCase):
    """A real build over a fake library: the blocker that `build --all` never
    parsed survived 31 unit tests, so the whole command runs here."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lib = Path(self.tmp.name)
        for mod, name in ((locate, 'LIB'), (locate, 'DB'), (locate, 'INDEX'), (search, 'LIB'), (search, 'DB')):
            self.addCleanup(setattr, mod, name, getattr(mod, name))
        for mod in (locate, search):
            mod.LIB = str(self.lib)
            mod.DB = str(self.lib / 'metadata.db')
        locate.INDEX = str(self.lib / '.read-doc')
        search._authors = None
        self.addCleanup(setattr, search, '_authors', None)
        fake_library(self.tmp.name, [(1, 'RM0001', ['reference-manual'], True),
                                     (2, 'Exposure', ['photography'], True)]).close()
        for bid, title in ((1, 'RM0001'), (2, 'Exposure')):
            (self.lib / f'Vendor/{title} ({bid})' / f'{title}.pdf').write_bytes(FIXTURE.read_bytes())

    def build(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = locate.main(['build', *args])
        self.summary = out.getvalue()
        return code

    def test_build_all_indexes_the_library_then_reports_the_rest_unchanged(self):
        self.assertEqual(self.build('--all'), 0)
        self.assertEqual(os.listdir(locate.INDEX), ['1.txt'], 'the photography book is skipped')
        meta, pages = locate.read_index(1)
        self.assertEqual(meta['pages'], 3)
        self.assertEqual(len(pages), 3)
        self.assertEqual(self.build('--all'), 0)
        self.assertIn('1 unchanged', self.summary, 'a second run re-extracts nothing')
        self.assertNotIn('indexed', self.summary)
        self.assertIn('2 book(s)', self.summary, 'the headline counts the skipped book too')

    def test_find_indexes_a_skipped_book_because_skipping_is_only_a_build_cost(self):
        self.build('--all')
        self.assertEqual(locate.main(['find', '--book', '2', '--term', 'SIE_CTRL']), 0)
        self.assertIn('2.txt', os.listdir(locate.INDEX))

    def test_a_book_whose_pdf_vanished_is_reported_not_silently_counted_as_done(self):
        os.remove(self.lib / 'Vendor/RM0001 (1)/RM0001.pdf')
        self.assertEqual(self.build('--all'), 3)

    def test_the_build_prunes_the_index_of_a_book_that_lost_its_pdf(self):
        self.build('--all')
        db = sqlite3.connect(locate.DB)
        db.execute('DELETE FROM data WHERE book = 1')
        db.commit()
        db.close()
        self.assertEqual(self.build('--all'), 0)
        self.assertEqual(os.listdir(locate.INDEX), [])

    def test_jobs_outside_its_range_is_a_usage_error(self):
        for jobs in ('0', '33', '-1'):
            self.assertEqual(self.build('--all', '--jobs', jobs), 2, jobs)


class Search(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name in ('LIB', 'DB', '_authors'):
            self.addCleanup(setattr, search, name, getattr(search, name))
        search.LIB, search.DB = self.tmp.name, os.path.join(self.tmp.name, 'metadata.db')
        search._authors = None
        fake_library(self.tmp.name, [
            (1, 'AN4839 Level 1 cache on STM32H7', ['application-note'], True),
            (2, 'RM0468 STM32H7 reference manual', ['reference-manual'], True),
            (3, 'ES0392 STM32H7 device errata', ['errata'], True),
            (4, 'DS12110 STM32F4 datasheet', ['datasheet'], True),
        ]).close()

    def run_search(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = search.main(list(args))
        return code, out.getvalue()

    def ids(self, out):
        """Book ids of the result rows; the count header also opens with a digit."""
        return [l.split()[0] for l in out.splitlines() if '  [' in l]

    def test_the_reference_manual_and_errata_come_before_the_application_note(self):
        code, out = self.run_search('stm32h7')
        self.assertEqual(code, 0)
        self.assertEqual(self.ids(out), ['2', '3', '1'])

    def test_the_header_counts_every_kind_that_matched_not_only_those_shown(self):
        _, out = self.run_search('stm32h7', '--limit', '1')
        self.assertIn('3 book(s): 1 reference-manual, 1 errata, 1 application-note', out)
        self.assertIn('showing 1', out)

    def test_kind_filters_and_all_keywords_must_match_by_default(self):
        code, out = self.run_search('--kind', 'errata', 'stm32h7')
        self.assertEqual(self.ids(out), ['3'])
        self.assertEqual(self.run_search('stm32h7', 'stm32f4')[0], 1, 'AND finds neither')
        self.assertEqual(self.run_search('stm32h7', 'stm32f4', '--any')[0], 0)

    def test_no_match_exits_one_so_a_caller_can_tell_it_from_a_bad_invocation(self):
        code, out = self.run_search('nosuchpart')
        self.assertEqual((code, out.strip()), (1, 'no match'))

    def test_the_path_is_printed_only_on_request_and_says_when_the_file_is_gone(self):
        self.assertNotIn('.pdf', self.run_search('rm0468')[1])
        self.assertIn('MISSING', self.run_search('rm0468', '--path')[1],
                      'the metadata is real even when the file is not on disk')


class Kinds(unittest.TestCase):
    def test_an_exact_tag_names_the_kind(self):
        for tags, kind in (('stm32, reference-manual', 'reference-manual'),
                           ('errata, STM32H7', 'errata'),
                           ('Data Sheet', 'datasheet'),
                           ("User's Guide", 'user-manual'),
                           ('application-note, nxp', 'application-note')):
            self.assertEqual(search.kind_of('x', tags), kind, tags)

    def test_an_abstract_stored_as_a_tag_does_not_classify_the_book(self):
        abstract = 'This application note describes the datasheet of the reference manual'
        self.assertEqual(search.kind_of('Making Embedded Systems', abstract), 'other')

    def test_several_kind_tags_classify_the_same_way_whatever_their_order(self):
        self.assertEqual(search.kind_of('x', 'datasheet, errata'), 'errata')
        self.assertEqual(search.kind_of('x', 'errata, datasheet'), 'errata')

    def test_an_untagged_book_falls_back_to_its_title_prefix(self):
        for title, kind in (('RM0492 STM32H503 line', 'reference-manual'),
                            ('ES0392 device errata', 'errata'),
                            ('DS12110 STM32H743VI', 'datasheet'),
                            ('AN4839 Level 1 cache', 'application-note'),
                            ('USB 2.0 specs', 'other')):
            self.assertEqual(search.kind_of(title, None), kind, title)


class Usage(unittest.TestCase):
    def run_script(self, script, *args):
        done = subprocess.run([sys.executable, str(SCRIPTS / script), *args],
                              capture_output=True, text=True)
        return done.returncode, done.stdout + done.stderr

    def test_build_needs_exactly_one_target(self):
        for args in (['build'], ['build', '--all', '--book', '1']):
            code, out = self.run_script('locate.py', *args)
            self.assertEqual(code, 2, args)
        code, out = self.run_script('locate.py')
        self.assertEqual(code, 2, 'a bare invocation is usage, not a default action')

    def test_an_unknown_or_malformed_option_is_a_usage_error_not_a_search_term(self):
        for script, args in (('search.py', ['--bogus', 'stm32']),
                             ('search.py', ['--kind', 'nonesuch', 'stm32']),
                             ('search.py', ['--limit', 'ten', 'stm32']),
                             ('locate.py', ['find', '--book', '1']),
                             ('locate.py', ['find', '--term', 'x']),
                             ('locate.py', ['build', '--book', 'abc'])):
            code, out = self.run_script(script, *args)
            self.assertEqual(code, 2, f'{script} {args}: {out}')

    def test_a_term_that_looks_like_an_option_is_still_a_term(self):
        code, out = self.run_script('locate.py', 'find', '--book', '1', '--term=--book')
        self.assertNotEqual(code, 2, out)

    def test_search_with_no_keyword_prints_usage(self):
        code, out = self.run_script('search.py')
        self.assertEqual(code, 2)
        self.assertIn('KEYWORD', out)


class FindUsage(unittest.TestCase):
    def args(self, **over):
        base = dict(book=1, term='x', context=2, limit=5, offset=0, max_chars=4000)
        return type('A', (), {**base, **over})()

    def test_a_limit_that_could_return_nothing_is_refused(self):
        for over in ({'limit': 0}, {'max_chars': 0}, {'max_chars': locate.MIN_CHARS - 1},
                     {'context': -1}, {'offset': -1}, {'term': '  '}):
            with self.assertRaises(ValueError, msg=over):
                locate.find_cmd(self.args(**over))


if __name__ == '__main__':
    unittest.main()
