<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE eagle SYSTEM "eagle.dtd">
<eagle version="9.6.2">
<drawing>
<layers>
<layer number="91" name="Nets" color="2" fill="1" visible="yes" active="yes"/>
</layers>
<schematic>
<libraries>
<library name="t">
<packages>
<package name="0603"/>
<package name="SOT363"/>
</packages>
<symbols>
<symbol name="R">
<pin name="1" x="0" y="0"/>
<pin name="2" x="0" y="2.54"/>
</symbol>
<symbol name="FET">
<pin name="D" x="0" y="0"/>
<pin name="S" x="0" y="2.54"/>
</symbol>
<symbol name="GND">
<pin name="GND" x="0" y="0"/>
</symbol>
</symbols>
<devicesets>
<deviceset name="R">
<gates>
<gate name="G$1" symbol="R" x="0" y="0"/>
</gates>
<devices>
<device name="_0603" package="0603">
<connects>
<connect gate="G$1" pin="1" pad="1"/>
<connect gate="G$1" pin="2" pad="2"/>
</connects>
<technologies>
<technology name="">
<attribute name="MPN" value="RC0603-DEFAULT"/>
</technology>
</technologies>
</device>
</devices>
</deviceset>
<deviceset name="DUALFET">
<gates>
<gate name="1" symbol="FET" x="0" y="0"/>
<gate name="2" symbol="FET" x="0" y="10"/>
</gates>
<devices>
<device name="" package="SOT363">
<connects>
<connect gate="1" pin="D" pad="6"/>
<connect gate="1" pin="S" pad="1 2"/>
<connect gate="2" pin="D" pad="3"/>
<connect gate="2" pin="S" pad="4"/>
</connects>
<technologies>
<technology name=""/>
</technologies>
</device>
</devices>
</deviceset>
<deviceset name="GND">
<gates>
<gate name="1" symbol="GND" x="0" y="0"/>
</gates>
<devices>
<device name="">
<technologies>
<technology name=""/>
</technologies>
</device>
</devices>
</deviceset>
</devicesets>
</library>
</libraries>
<parts>
<part name="R1" library="t" deviceset="R" device="_0603" value="10k">
<attribute name="MPN" value="RC0603FR-0710KL"/>
</part>
<part name="R2" library="t" deviceset="R" device="_0603" value="1k"/>
<part name="R3" library="t" deviceset="R" device="_0603" value="0R">
<variant name="lite" populate="no"/>
</part>
<part name="Q1" library="t" deviceset="DUALFET" device="" value="BSS138DW"/>
<part name="GND1" library="t" deviceset="GND" device=""/>
</parts>
<sheets>
<sheet>
<nets>
<net name="SIG" class="0">
<segment>
<pinref part="R1" gate="G$1" pin="1"/>
<pinref part="Q1" gate="1" pin="D"/>
</segment>
</net>
<net name="GND" class="0">
<segment>
<pinref part="R1" gate="G$1" pin="2"/>
<pinref part="GND1" gate="1" pin="GND"/>
</segment>
</net>
</nets>
</sheet>
<sheet>
<busses>
<bus name="B[0..1]">
<segment>
<wire x1="0" y1="0" x2="10" y2="0" width="0.762" layer="92"/>
</segment>
</bus>
</busses>
<nets>
<net name="SIG" class="0">
<segment>
<pinref part="R2" gate="G$1" pin="1"/>
<pinref part="R1" gate="G$1" pin="1"/>
</segment>
</net>
<net name="GND" class="0">
<segment>
<pinref part="Q1" gate="2" pin="S"/>
</segment>
</net>
<net name="B0" class="0">
<segment>
<pinref part="R2" gate="G$1" pin="2"/>
</segment>
</net>
<net name="B1" class="0">
<segment>
<pinref part="R3" gate="G$1" pin="1"/>
</segment>
</net>
</nets>
</sheet>
</sheets>
</schematic>
</drawing>
</eagle>
