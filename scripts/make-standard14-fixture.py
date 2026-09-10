"""Builds test-standard14.pdf - a tagged one-page PDF whose font is a
standard-14 face carrying no /Widths.

That combination is what standard_fonts.py exists for, and none of the other
fixtures have it: every font in test-complex.pdf embeds its own
metrics. Without this the AFM path would only ever be exercised by documents
outside the repo.

The font is /Helvetica with a /ToUnicode but no /Widths and no
/FontDescriptor - exactly what a word processor emits for a non-embedded
standard face, and exactly the case where Split Content could already divide
a leaf that the rectangle tool had to refuse.

    python scripts/make-standard14-fixture.py
"""

import os
import zlib

import pikepdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test-standard14.pdf")

LINES = [
    (72, 720, "Standard fourteen, no widths."),
    (72, 700, "This paragraph is one marked-content span."),
    (72, 680, "Splitting it needs AFM metrics."),
]

# Identity for printable ASCII: the codes are WinAnsi, which agrees with
# Unicode over this range, so the mapping is one bfrange.
TOUNICODE = b"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Custom def
/CMapType 2 def
1 begincodespacerange
<20> <7E>
endcodespacerange
1 beginbfrange
<20> <7E> <0020>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"""


def build():
    pdf = pikepdf.Pdf.new()

    tounicode = pdf.make_stream(zlib.compress(TOUNICODE))
    tounicode["/Filter"] = pikepdf.Name("/FlateDecode")

    font = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Font"),
        "/Subtype": pikepdf.Name("/Type1"),
        "/BaseFont": pikepdf.Name("/Helvetica"),
        "/Encoding": pikepdf.Name("/WinAnsiEncoding"),
        "/ToUnicode": tounicode,
        # Deliberately no /Widths and no /FontDescriptor - that's the point.
    }))

    def escape(text):
        return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    body = ["/P <</MCID 0>> BDC", "BT", "/F1 12 Tf"]
    for x, y, text in LINES:
        body.append(f"1 0 0 1 {x} {y} Tm ({escape(text)}) Tj")
    body += ["ET", "EMC"]
    content = pdf.make_stream("\n".join(body).encode("latin-1"))

    page = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Page"),
        "/MediaBox": pikepdf.Array([0, 0, 612, 792]),
        "/Resources": pikepdf.Dictionary({"/Font": pikepdf.Dictionary({"/F1": font})}),
        "/Contents": content,
    }))
    pdf.pages.append(pikepdf.Page(page))
    page_obj = pdf.pages[0].obj

    struct_root = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructTreeRoot"),
    }))
    paragraph = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/P"),
        "/Pg": page_obj,
        "/K": 0,
    }))
    document = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/Document"),
        "/P": struct_root,
        "/K": pikepdf.Array([paragraph]),
    }))
    paragraph["/P"] = document
    struct_root["/K"] = pikepdf.Array([document])

    # /ParentTree: one number-tree entry mapping this page's /StructParents
    # to the element owning each of its MCIDs.
    struct_root["/ParentTree"] = pdf.make_indirect(pikepdf.Dictionary({
        "/Nums": pikepdf.Array([0, pikepdf.Array([paragraph])]),
    }))
    struct_root["/ParentTreeNextKey"] = 1
    page_obj["/StructParents"] = 0

    pdf.Root["/StructTreeRoot"] = struct_root
    pdf.Root["/MarkInfo"] = pikepdf.Dictionary({"/Marked": True})
    pdf.Root["/Lang"] = pikepdf.String("en-US")

    pdf.save(OUT)
    print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    build()
