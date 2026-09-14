"""Builds test-verify.pdf - a tagged two-page PDF built to fail, on purpose,
every check the Verify panel gained alongside it.

The other fixtures are shaped around editing operations: what happens to a
tree when you flatten, join or split something. This one is shaped around
*reporting* - it exists so the checks have something to find, and so a
regression shows up as a check going quiet rather than as a broken document.

Deliberately wrong, one issue per shape:

  page 1 has no /Tabs at all, page 2 sets /Tabs /S
      The tab-order check is per page, so a fixture where every page agrees
      would pass or fail as a block and never prove the check (or
      set_structure_tab_order()'s fix) looks at pages individually.

  three /Link annotations on page 1
      One tagged (an /OBJR under a /Link element) and carrying /Contents -
      the one that should pass both link checks. One tagged with no
      description anywhere. One with no /OBJR pointing at it at all, which
      is both untagged and undescribed, and is the case with no tag for the
      report to link to.

  a Figure whose marked content paints text
      It has /Alt, so the alternate-text check passes on it and the only
      thing left to flag is the text inside it.

  an H2 with no H1 above it, an empty H3, an empty Div
  an LI holding a Lbl and its content directly, with no LBody
      Tag-tree shapes, checked in the renderer rather than here - the fixture
      carries them so the checks have a document to be pointed at by hand,
      and so they can be covered from the worker side if that ever becomes
      possible.

No XMP metadata is written, so pdfuaid:part is absent and the PDF/UA check
has something to report (and set_pdf_ua_identifier() something to write).

    python scripts/make-verify-fixture.py
"""

import os

import pikepdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test-verify.pdf")

# (mcid, text) per page, in the order they're painted. Every run is its own
# BDC/EMC span, so each MCID names one distinct piece of real text - and the
# one inside the Figure is real text too, which is the point of it.
PAGE_ONE = [
    (0, "A second-level heading with no first-level heading above it"),
    (1, "An ordinary paragraph of body text."),
    (2, "1."),
    (3, "List item text sitting loose in the LI, with no LBody around it."),
    (4, "A link that is tagged and described."),
    (5, "A link that is tagged but has no description."),
    (6, "TEXT PAINTED INSIDE A FIGURE"),
]
PAGE_TWO = [
    (0, "Page two body text."),
]


def escape(text):
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def content_for(pdf, runs):
    body = []
    for i, (mcid, text) in enumerate(runs):
        body.append(f"/P <</MCID {mcid}>> BDC")
        body.append("BT")
        body.append("/F1 12 Tf")
        body.append(f"1 0 0 1 72 {720 - i * 20} Tm ({escape(text)}) Tj")
        body.append("ET")
        body.append("EMC")
    return pdf.make_stream("\n".join(body).encode("latin-1"))


def build():
    pdf = pikepdf.Pdf.new()

    font = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Font"),
        "/Subtype": pikepdf.Name("/Type1"),
        "/BaseFont": pikepdf.Name("/Helvetica"),
        "/Encoding": pikepdf.Name("/WinAnsiEncoding"),
    }))

    for runs in (PAGE_ONE, PAGE_TWO):
        page = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/Page"),
            "/MediaBox": pikepdf.Array([0, 0, 612, 792]),
            "/Resources": pikepdf.Dictionary({"/Font": pikepdf.Dictionary({"/F1": font})}),
            "/Contents": content_for(pdf, runs),
        }))
        pdf.pages.append(pikepdf.Page(page))
    p1, p2 = pdf.pages[0].obj, pdf.pages[1].obj

    # Page 1 deliberately says nothing about tab order; page 2 gets it right.
    p2["/Tabs"] = pikepdf.Name("/S")

    def elem(role, **entries):
        return pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name(f"/{role}"),
            **{f"/{key}": value for key, value in entries.items()},
        }))

    def link_annot(y, contents=None):
        entries = {
            "/Type": pikepdf.Name("/Annot"),
            "/Subtype": pikepdf.Name("/Link"),
            "/Rect": pikepdf.Array([72, y, 400, y + 14]),
            "/Border": pikepdf.Array([0, 0, 0]),
            "/A": pikepdf.Dictionary({
                "/Type": pikepdf.Name("/Action"),
                "/S": pikepdf.Name("/URI"),
                "/URI": pikepdf.String("https://example.com/"),
            }),
        }
        if contents is not None:
            entries["/Contents"] = pikepdf.String(contents)
        return pdf.make_indirect(pikepdf.Dictionary(entries))

    described_annot = link_annot(640, "Example website")
    undescribed_annot = link_annot(620)
    untagged_annot = link_annot(600)
    p1["/Annots"] = pikepdf.Array([described_annot, undescribed_annot, untagged_annot])

    def objr(target):
        return pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OBJR"),
            "/Obj": target,
        }))

    heading = elem("H2", Pg=p1, K=0)
    body_p = elem("P", Pg=p1, K=1)

    # A list item that holds its label and its text directly: no LBody at
    # all, which is the pairing rule's whole point.
    label = elem("Lbl", Pg=p1, K=2)
    list_item = elem("LI", Pg=p1, K=pikepdf.Array([label, 3]))
    the_list = elem("L", Pg=p1, K=pikepdf.Array([list_item]))

    described_objr = objr(described_annot)
    described_link = elem("Link", Pg=p1, K=pikepdf.Array([4, described_objr]))
    described_link_p = elem("P", Pg=p1, K=pikepdf.Array([described_link]))

    undescribed_objr = objr(undescribed_annot)
    undescribed_link = elem("Link", Pg=p1, K=pikepdf.Array([5, undescribed_objr]))
    undescribed_link_p = elem("P", Pg=p1, K=pikepdf.Array([undescribed_link]))
    # untagged_annot deliberately gets no /OBJR and no /StructParent.

    # Alt is present, so the only thing left to report about this Figure is
    # the live text its marked content paints.
    figure = elem("Figure", Pg=p1, K=6, Alt=pikepdf.String("A figure with text drawn inside it"))

    page_two_p = elem("P", Pg=p2, K=0)
    empty_heading = elem("H3", Pg=p2)
    empty_div = elem("Div", Pg=p2)

    struct_root = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructTreeRoot"),
    }))
    top_level = [
        heading, body_p, the_list, described_link_p, undescribed_link_p,
        figure, page_two_p, empty_heading, empty_div,
    ]
    document = elem("Document", K=pikepdf.Array(top_level))
    document["/P"] = struct_root
    struct_root["/K"] = pikepdf.Array([document])

    for parent, kids in (
        (document, top_level),
        (the_list, [list_item]),
        (list_item, [label]),
        (described_link_p, [described_link]),
        (described_link, [described_objr]),
        (undescribed_link_p, [undescribed_link]),
        (undescribed_link, [undescribed_objr]),
    ):
        for kid in kids:
            kid["/P"] = parent

    # /ParentTree: per page, an array indexed by MCID naming the element that
    # owns it, plus one entry per tagged annotation (an element, not an
    # array, since an annotation is a single object rather than a run of
    # marked content). Only has to be right for the file as built - every
    # mutating command rewrites it from the tree afterwards.
    struct_root["/ParentTree"] = pdf.make_indirect(pikepdf.Dictionary({
        "/Nums": pikepdf.Array([
            0, pikepdf.Array([heading, body_p, label, list_item,
                              described_link, undescribed_link, figure]),
            1, pikepdf.Array([page_two_p]),
            2, described_link,
            3, undescribed_link,
        ]),
    }))
    struct_root["/ParentTreeNextKey"] = 4
    p1["/StructParents"] = 0
    p2["/StructParents"] = 1
    described_annot["/StructParent"] = 2
    undescribed_annot["/StructParent"] = 3

    pdf.Root["/StructTreeRoot"] = struct_root
    pdf.Root["/MarkInfo"] = pikepdf.Dictionary({"/Marked": True})
    pdf.Root["/Lang"] = pikepdf.String("en-US")

    pdf.save(OUT)
    print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    build()
