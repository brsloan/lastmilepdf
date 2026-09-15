"""Builds assets/quickstart.pdf - the quick-start tutorial as a tagged PDF.

Two jobs in one file, which is why it is worth shipping at all:

  * It is the tutorial. A first run opens it (see the Quickstart section in
    main.js), so the app starts with something on screen that explains itself
    rather than an empty window.

  * It is a document to practise on. Much of what the text talks about is
    here to try on: headings to re-level, paragraphs to join and split,
    ordered lists nested two deep with their labels tagged separately, and
    a few paragraphs whose text carries across a page break - the case the
    tutorial singles out as the reason J joins upwards. Those last ones are
    wherever the text happens to fall rather than anything arranged, so they
    move as QUICKSTART.md and the sizes below are edited.

The structure is deliberately correct, not deliberately broken. The fixtures
in the repo root are the ones built to be wrong (test-verify.pdf especially);
this one is what a well-tagged document looks like, so that practising on it
starts from a clean tree, and so the tag tree, Verify, Actual Text and the
table tools all have something honest to show.

The text comes from QUICKSTART.md via scripts/quickstart-doc.js, which parses
it once and hands the blocks over as JSON - so the PDF and the in-app
Quickstart dialog can't drift apart. Run the whole chain with:

    npm run quickstart

Fonts are the standard 14, carrying /ToUnicode but no /Widths: the shape
test-standard14.pdf exists for, so the AFM path in standard_fonts.py is what
places every glyph here. Metrics come from python/standard_fonts_data.py, the
same table the worker uses, so the layout below and the app's own idea of
where the text sits are measured from one source.
"""

import json
import os
import sys
import zlib

import pikepdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from standard_fonts_data import ENCODINGS, WIDTHS  # noqa: E402

DEFAULT_BLOCKS = os.path.join(ROOT, "build", "quickstart-blocks.json")
DEFAULT_OUT = os.path.join(ROOT, "assets", "quickstart.pdf")

TITLE = "LastMilePDF Quick Start"

# --- page geometry (PDF units, 1/72") ---------------------------------------

PAGE_WIDTH = 612
PAGE_HEIGHT = 792
# Wider than a default word-processor margin on purpose. Body text is set
# large (see STYLES), and a long line of large text is harder to read rather
# than easier: the eye loses its place on the way back to the left edge. The
# 432pt column left here is about two and a half lowercase alphabets at 14pt,
# inside the two-to-three the measure wants, and tops out near 77 characters
# a line. The full 468pt measure would run to about 90.
MARGIN_X = 90
TOP = 720
BOTTOM = 72
COLUMN = PAGE_WIDTH - 2 * MARGIN_X

# Per level: how far the label is indented, and how far its text hangs beyond.
LIST_INDENT = 30
LABEL_GAP = 28

# font key -> the BaseFont it is /Fn for on every page
FONTS = {
    "F1": "Helvetica",
    "F2": "Helvetica-Bold",
    "F3": "Helvetica-Oblique",
    "F4": "Courier",
}
RUN_FONTS = {"plain": "F1", "bold": "F2", "italic": "F3", "code": "F4"}

# size, leading, space above, space below - one entry per thing being drawn.
#
# Body text is 14pt, well above the 10 or 11 a print document would use. This
# one is read on screen, at whatever zoom the preview pane happens to be at
# beside a tag tree and a properties panel - and Helvetica has thin, even
# strokes that go weak and grey as they get smaller, whatever the fill says.
# Nothing here is anything but pure black; size and leading are what make it
# legible. Headings are scaled with the body so the hierarchy holds.
STYLES = {
    "h1": {"font": "F2", "size": 28, "leading": 34, "above": 0, "below": 18},
    "h2": {"font": "F2", "size": 20, "leading": 24, "above": 28, "below": 10},
    "h3": {"font": "F2", "size": 15.5, "leading": 19.5, "above": 21, "below": 7},
    "para": {"font": "F1", "size": 14, "leading": 19.5, "above": 0, "below": 14},
    "item": {"font": "F1", "size": 14, "leading": 19.5, "above": 0, "below": 9},
}

HEADING_STYLE = {1: "h1", 2: "h2", 3: "h3"}
HEADING_ROLE = {1: "H1", 2: "H2", 3: "H3"}

# --- WinAnsi ----------------------------------------------------------------
#
# Characters above Latin-1 that WinAnsiEncoding still has a code for - the
# curly quotes, dashes and ellipsis QUICKSTART.md is written with. Everything
# else in the file is Latin-1, where the code is the code point. Anything that
# is neither raises rather than being dropped or mangled into a lookalike:
# silently losing a character from the tutorial is worse than a failed build.
WINANSI_SPECIALS = {
    "\u20ac": 0x80, "\u201a": 0x82, "\u0192": 0x83, "\u201e": 0x84,
    "\u2026": 0x85, "\u2020": 0x86, "\u2021": 0x87, "\u02c6": 0x88,
    "\u2030": 0x89, "\u0160": 0x8A, "\u2039": 0x8B, "\u0152": 0x8C,
    "\u017d": 0x8E, "\u2018": 0x91, "\u2019": 0x92, "\u201c": 0x93,
    "\u201d": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
    "\u02dc": 0x98, "\u2122": 0x99, "\u0161": 0x9A, "\u203a": 0x9B,
    "\u0153": 0x9C, "\u017e": 0x9E, "\u0178": 0x9F,
}

WINANSI_NAMES = ENCODINGS["WinAnsiEncoding"]


def winansi_code(char):
    if char in WINANSI_SPECIALS:
        return WINANSI_SPECIALS[char]
    code = ord(char)
    if 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:
        return code
    raise ValueError(f"WinAnsiEncoding has no code for {char!r} (U+{code:04X})")


def encode(text):
    return bytes(winansi_code(char) for char in text)


def glyph_width(char, font):
    widths = WIDTHS[FONTS[font]]
    if isinstance(widths, (int, float)):
        return widths  # the Courier faces are monospaced
    name = WINANSI_NAMES[winansi_code(char)]
    return widths.get(name, 0)


def measure(text, font, size):
    return sum(glyph_width(char, font) for char in text) * size / 1000.0


def pdf_string(text):
    """One literal string operand, escaped for a content stream."""
    out = bytearray()
    for byte in encode(text):
        if byte in b"()\\":
            out.append(0x5C)
        out.append(byte)
    return "(" + out.decode("latin-1") + ")"


# --- structure elements -----------------------------------------------------


class Elem:
    """One /StructElem, before it becomes PDF objects.

    Kids are collected as ("mc", page, mcid) or ("elem", child) in reading
    order, so an element that runs across a page break simply ends up with
    marked content from two pages - which build_struct_tree() then writes as
    /MCR dictionaries naming the second page.
    """

    def __init__(self, role, **entries):
        self.role = role
        self.entries = entries
        self.kids = []
        self.obj = None

    def child(self, role, **entries):
        kid = Elem(role, **entries)
        self.kids.append(("elem", kid))
        return kid

    def mark(self, page, mcid):
        self.kids.append(("mc", page, mcid))

    def pages(self):
        return [page for kind, page, *_ in self.kids if kind == "mc"]


# --- layout -----------------------------------------------------------------


class Layout:
    """Places text on pages and records the marked content as it goes."""

    # Every page opens by setting the fill to black. That is already the PDF
    # default, so it changes nothing on the page - it is here so the colour
    # is stated rather than inherited, and so "is the text actually black?"
    # is a question the file answers on its own.
    BLACK = "0 g"

    def __init__(self):
        self.pages = [[self.BLACK]]   # per page: content-stream operator lines
        self.owners = [[]]            # per page: element owning each MCID, by index
        self.page = 0
        self.y = TOP

    def new_page(self):
        self.pages.append([self.BLACK])
        self.owners.append([])
        self.page = len(self.pages) - 1
        self.y = TOP

    def space(self, amount):
        # Space above a block is only space *between* blocks: at the top of a
        # page there is nothing above it to be separated from.
        if amount and self.y < TOP:
            self.y -= amount

    def room_for(self, height):
        return self.y - height >= BOTTOM

    def wrap(self, runs, width, style, font_override=None):
        """Runs -> lines, each a list of (font, text) segments.

        Greedy, measured with the same AFM widths the app reads, so a line
        that fits here fits when the app places it too.
        """
        atoms = []  # (text, font, is_space)
        for run in runs:
            font = font_override or RUN_FONTS.get(run["style"], "F1")
            parts = run["text"].replace("\t", " ").split(" ")
            for i, part in enumerate(parts):
                if i:
                    atoms.append((" ", font, True))
                if part:
                    atoms.append((part, font, False))

        lines = []
        current = []
        used = 0.0
        for text, font, is_space in atoms:
            advance = measure(text, font, style["size"])
            if is_space:
                if not current:
                    continue  # a space that would open a line is dropped
                current.append((text, font, advance))
                used += advance
                continue
            if current and used + advance > width:
                while current and current[-1][0] == " ":
                    used -= current.pop()[2]
                lines.append(current)
                current = []
                used = 0.0
            current.append((text, font, advance))
            used += advance
        while current and current[-1][0] == " ":
            current.pop()
        if current:
            lines.append(current)
        return lines or [[]]

    def draw(self, lines, x, style, element, tag):
        """Draws already-wrapped lines, breaking pages where they run out.

        Each unbroken run of lines on one page is one marked-content span, so
        a paragraph split by a page break becomes exactly two MCIDs on two
        pages under one element - the shape the tag tree draws its page-break
        line through, and the one J joins back together.
        """
        size = style["size"]
        leading = style["leading"]
        open_span = False

        def close():
            nonlocal open_span
            if open_span:
                self.pages[self.page].append("EMC")
                open_span = False

        for index, line in enumerate(lines):
            if not self.room_for(leading):
                close()
                self.new_page()
            if not open_span:
                mcid = len(self.owners[self.page])
                self.owners[self.page].append(element)
                element.mark(self.page, mcid)
                self.pages[self.page].append(f"/{tag} <</MCID {mcid}>> BDC")
                open_span = True

            self.y -= leading

            # Neighbouring segments in the same font become one string, spaces
            # and all. Drawing word by word and stepping over the gaps would
            # look identical on the page and extract as
            # "Thisappisallaboutmaking": whatever reads the text back - the
            # Actual Text preview above all - gets only the glyphs that were
            # actually painted, and a space that was skipped was never there.
            merged = []
            for text, font, advance in line:
                if merged and merged[-1][1] == font:
                    merged[-1][0] += text
                    merged[-1][2] += advance
                else:
                    merged.append([text, font, advance])

            # The space the wrap dropped at this line's end has to be painted
            # somewhere or the extracted text reads "a tagand press": the line
            # break itself contributes nothing, because nothing was drawn for
            # it. It goes on the end of this line rather than the start of the
            # next, where it would push the first word out of the margin.
            if merged and index < len(lines) - 1:
                merged[-1][0] += " "

            ops = ["BT"]
            at = x
            for text, font, advance in merged:
                ops.append(f"/{font} {size:g} Tf")
                ops.append(f"1 0 0 1 {at:.2f} {self.y:.2f} Tm {pdf_string(text)} Tj")
                at += advance
            ops.append("ET")
            self.pages[self.page].extend(ops)

        close()
        self.y -= style["below"]


# --- walking the blocks -----------------------------------------------------


def emit_block(layout, block, parent):
    if block["type"] == "heading":
        emit_heading(layout, block, parent)
    elif block["type"] == "para":
        emit_para(layout, block["runs"], parent, MARGIN_X, COLUMN, "P", STYLES["para"])
    else:
        emit_list(layout, block, parent, 0)


def emit_heading(layout, block, parent):
    level = min(block["level"], 3)
    style = STYLES[HEADING_STYLE[level]]
    role = HEADING_ROLE[level]
    lines = layout.wrap(block["runs"], COLUMN, style, font_override=style["font"])

    layout.space(style["above"])
    # Keep a heading with what it introduces: a heading alone at the foot of a
    # page reads as a dangling label, and in the tag tree it looks like the
    # section starts on the wrong page.
    needed = len(lines) * style["leading"] + style["below"] + STYLES["para"]["leading"] * 2
    if layout.y < TOP and not layout.room_for(needed):
        layout.new_page()

    element = parent.child(role)
    layout.draw(lines, MARGIN_X, style, element, role)


def emit_para(layout, runs, parent, x, width, tag, style):
    layout.space(style["above"])
    element = parent.child(tag)
    layout.draw(layout.wrap(runs, width, style), x, style, element, tag)
    return element


def emit_list(layout, block, parent, level):
    style = STYLES["item"]
    list_elem = parent.child("L")
    if block["ordered"]:
        # PDF/UA wants a list to say how it is numbered; the app reads it back
        # in the Tag Properties panel.
        list_elem.entries["A"] = {"O": "List", "ListNumbering": "Decimal"}
    else:
        list_elem.entries["A"] = {"O": "List", "ListNumbering": "Disc"}

    label_x = MARGIN_X + level * LIST_INDENT
    text_x = label_x + LABEL_GAP
    width = MARGIN_X + COLUMN - text_x

    for number, item in enumerate(block["items"], start=1):
        item_elem = list_elem.child("LI")
        label = f"{number}." if block["ordered"] else "\u2022"

        # A label is only ever one line, so it will always find room where its
        # first line of text would not - which would leave "3." alone at the
        # foot of a page and its step at the top of the next one. Take the page
        # break before the label rather than after it.
        if not layout.room_for(style["leading"]):
            layout.new_page()

        # The label and the body are two elements but one line: draw the label,
        # then put the cursor back so the body starts beside it rather than
        # under it.
        lbl = item_elem.child("Lbl")
        before = layout.y
        layout.draw([[(label, "F1", measure(label, "F1", style["size"]))]], label_x, style, lbl, "Lbl")
        layout.y = before

        body = item_elem.child("LBody")
        layout.draw(layout.wrap(item["runs"], width, style), text_x, style, body, "LBody")

        for child in item["children"]:
            emit_list(layout, child, body, level + 1)


# --- assembling the PDF -----------------------------------------------------


def to_unicode_cmap(codes):
    """A /ToUnicode CMap covering exactly the codes this document paints.

    Without one, a WinAnsi code above 0x7F extracts as whatever the consumer
    guesses - and the tutorial is full of curly quotes and dashes, which is
    precisely the text the Actual Text preview shows back to the user.
    """
    entries = "\n".join(f"<{code:02X}> <{ord(char):04X}>" for code, char in sorted(codes.items()))
    return f"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /LastMilePDF-WinAnsi def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
{len(codes)} beginbfchar
{entries}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
""".encode("latin-1")


def collect_codes(blocks):
    """Every character the document paints, as code -> character."""
    codes = {}

    def add(text):
        for char in text:
            codes[winansi_code(char)] = char

    def walk(block):
        if block["type"] == "list":
            add("0123456789.\u2022")
            for item in block["items"]:
                for run in item["runs"]:
                    add(run["text"])
                for child in item["children"]:
                    walk(child)
        else:
            for run in block["runs"]:
                add(run["text"])

    for block in blocks:
        walk(block)
    return codes


def name(value):
    return pikepdf.Name(value if value.startswith("/") else f"/{value}")


def build_struct_tree(pdf, root_elem, page_objs, struct_root):
    """Turns the Elem tree into /StructElem objects, and returns the ParentTree
    entry for each page."""

    def build(elem, parent_obj):
        entries = {
            "/Type": pikepdf.Name("/StructElem"),
            "/S": name(elem.role),
            "/P": parent_obj,
        }
        pages = elem.pages()
        if pages:
            entries["/Pg"] = page_objs[pages[0]]
        attrs = elem.entries.get("A")
        if attrs:
            entries["/A"] = pikepdf.Dictionary(
                {f"/{key}": name(value) for key, value in attrs.items()}
            )
        obj = pdf.make_indirect(pikepdf.Dictionary(entries))
        elem.obj = obj

        home = pages[0] if pages else None
        kids = []
        for kid in elem.kids:
            if kid[0] == "elem":
                kids.append(build(kid[1], obj))
            else:
                _, page, mcid = kid
                if page == home:
                    kids.append(mcid)
                else:
                    # Marked content on a page other than the element's own
                    # has to name its page, which only /MCR can do.
                    kids.append(pikepdf.Dictionary({
                        "/Type": pikepdf.Name("/MCR"),
                        "/Pg": page_objs[page],
                        "/MCID": mcid,
                    }))
        if kids:
            obj["/K"] = pikepdf.Array(kids) if len(kids) > 1 else kids[0]
        return obj

    document = build(root_elem, struct_root)
    struct_root["/K"] = pikepdf.Array([document])


def build(blocks, out_path):
    layout = Layout()
    document = Elem("Document")
    for block in blocks:
        emit_block(layout, block, document)

    pdf = pikepdf.Pdf.new()

    tounicode = pdf.make_stream(zlib.compress(to_unicode_cmap(collect_codes(blocks))))
    tounicode["/Filter"] = pikepdf.Name("/FlateDecode")

    fonts = {}
    for key, base in FONTS.items():
        fonts[key] = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/Font"),
            "/Subtype": pikepdf.Name("/Type1"),
            "/BaseFont": name(base),
            "/Encoding": pikepdf.Name("/WinAnsiEncoding"),
            "/ToUnicode": tounicode,
            # No /Widths and no /FontDescriptor: a standard-14 face is allowed
            # to leave its metrics to the AFM tables, and doing so here keeps
            # the tutorial exercising standard_fonts.py rather than a path only
            # documents from outside the repo ever reach.
        }))
    font_resource = pikepdf.Dictionary({f"/{key}": obj for key, obj in fonts.items()})

    page_objs = []
    for index, ops in enumerate(layout.pages):
        page = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/Page"),
            "/MediaBox": pikepdf.Array([0, 0, PAGE_WIDTH, PAGE_HEIGHT]),
            "/Resources": pikepdf.Dictionary({"/Font": font_resource}),
            "/Contents": pdf.make_stream("\n".join(ops).encode("latin-1")),
            # Reading order follows the structure tree, which is the answer the
            # tab-order check in the Verify panel looks for.
            "/Tabs": pikepdf.Name("/S"),
            "/StructParents": index,
        }))
        pdf.pages.append(pikepdf.Page(page))
        page_objs.append(pdf.pages[index].obj)

    struct_root = pdf.make_indirect(pikepdf.Dictionary({"/Type": pikepdf.Name("/StructTreeRoot")}))
    build_struct_tree(pdf, document, page_objs, struct_root)

    # /ParentTree: per page, the element owning each MCID, indexed by MCID. An
    # element appears once per MCID it owns, so a paragraph broken over a page
    # break is named on both pages.
    nums = []
    for index, owners in enumerate(layout.owners):
        nums.append(index)
        nums.append(pikepdf.Array([owner.obj for owner in owners]))
    struct_root["/ParentTree"] = pdf.make_indirect(pikepdf.Dictionary({"/Nums": pikepdf.Array(nums)}))
    struct_root["/ParentTreeNextKey"] = len(layout.pages)

    pdf.Root["/StructTreeRoot"] = struct_root
    pdf.Root["/MarkInfo"] = pikepdf.Dictionary({"/Marked": True})
    pdf.Root["/Lang"] = pikepdf.String("en-US")
    # A document with a title should be shown by it rather than by its file
    # name - one of the things the Verify panel reports on.
    pdf.Root["/ViewerPreferences"] = pikepdf.Dictionary({"/DisplayDocTitle": True})

    with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
        meta["dc:title"] = TITLE
        meta["pdfuaid:part"] = "1"
    pdf.docinfo["/Title"] = TITLE

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    pdf.save(out_path)
    return len(layout.pages)


def main():
    blocks_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BLOCKS
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    with open(blocks_path, encoding="utf-8") as handle:
        blocks = json.load(handle)
    pages = build(blocks, out_path)
    print(f"wrote {os.path.relpath(out_path, ROOT)} ({pages} pages)")


if __name__ == "__main__":
    main()
