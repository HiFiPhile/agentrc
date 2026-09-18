"""Tests for download-doc's plan(): a document already filed by hand is
reported as legacy, never imported a second time."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills' / 'download-doc' / 'scripts'))
import doclib  # noqa: E402


def doc(doc_id, aliases=()):
    return doclib.Doc(vendor='st', doc_id=doc_id, doc_type='reference-manual', version='8.0',
                      title='t', url='u', author='STMicroelectronics', aliases=list(aliases))


def legacy(*titles):
    return {doclib.norm_title(t): {'id': n, 'title': t} for n, t in enumerate(titles, 1)}


class Legacy(unittest.TestCase):
    def verdict(self, d, titles):
        p = doclib.plan([d], {}, legacy(*titles))
        return [hit['id'] for _, hit in p['legacy']], len(p['new'])

    def test_a_short_vendor_code_claims_a_hand_filed_title_it_opens(self):
        title = 'RM0433 STM32H742, STM32H743/753 and STM32H750 Value line - Reference manual'
        self.assertEqual(self.verdict(doc('RM0433'), [title]), ([1], 0))

    def test_a_code_does_not_claim_a_title_it_only_begins_like(self):
        self.assertEqual(self.verdict(doc('RM0433'), ['RM04331 something else']), ([], 1))

    def test_a_short_plain_word_still_needs_an_exact_title(self):
        self.assertEqual(self.verdict(doc('x', ['Pico']), ['Pico W Datasheet']), ([], 1))
        self.assertEqual(self.verdict(doc('x', ['Pico']), ['Pico']), ([1], 0))

    def test_a_long_alias_matches_on_a_whole_word_prefix(self):
        self.assertEqual(self.verdict(doc('x', ['RP2040 Datasheet']),
                                      ['RP2040 Datasheet: A microcontroller by Raspberry Pi']), ([1], 0))

    def test_a_part_number_does_not_claim_another_document_of_that_part(self):
        ti = doc('TM4C123GH6PM', ['TM4C123GH6PM Datasheet', 'TM4C123GH6PM'])
        self.assertEqual(self.verdict(ti, ['TM4C123GH6PM Errata']), ([], 1))

    def test_a_short_part_number_is_not_a_document_code(self):
        self.assertEqual(self.verdict(doc('PF3000'), ['PF3000 Evaluation Board User Guide']), ([], 1))

    def test_an_exact_title_wins_over_an_earlier_prefix(self):
        ti = doc('TM4C123GH6PM', ['TM4C123GH6PM Datasheet', 'TM4C123GH6PM'])
        self.assertEqual(self.verdict(ti, ['TM4C123GH6PM Datasheet extra', 'TM4C123GH6PM']), ([2], 0))

    def test_a_book_with_an_identifier_is_compared_by_revision_not_title(self):
        p = doclib.plan([doc('RM0433')], {'st:RM0433': {'rev': '8.0'}}, legacy('RM0433 manual'))
        self.assertEqual((p['current'], p['legacy']), ([doc('RM0433')], []))


if __name__ == '__main__':
    unittest.main()
