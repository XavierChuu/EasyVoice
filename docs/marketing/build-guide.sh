#!/usr/bin/env bash
# Rebuild Evoice-User-Guide.pdf from guide/guide.html + guide/cover.html.
# Needs Microsoft Edge (headless print) and PyMuPDF (merge cover, patch cover page numbers).
set -e
cd "$(dirname "$0")"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
print() { "$EDGE" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="$(cygpath -w "$PWD/$2")" "file:///$(cygpath -m "$PWD/$1")" >/dev/null 2>&1; }
merge() { PYTHONIOENCODING=utf-8 python - <<'PY'
import fitz
body=fitz.open('.body.pdf'); cover=fitz.open('.cover.pdf')
body.delete_page(0); body.insert_pdf(cover,from_page=0,to_page=0,start_at=0)
en=vi=None
for i,p in enumerate(body):
    t=p.get_text()
    if en is None and 'Evoice User Guide' in t and 'PART 1' in t.upper(): en=i+1
    if vi is None and 'Hướng dẫn sử dụng Evoice' in t: vi=i+1
body.save('Evoice-User-Guide.pdf',garbage=3,deflate=True); print(en,vi)
PY
}
print guide/guide.html .body.pdf
print guide/cover.html .cover.pdf
read EN VI <<<"$(merge)"
sed -i -E "s|(id=\"en-page\">)[0-9]+|\1$EN|; s|(id=\"vi-page\">)[0-9]+|\1$VI|" guide/cover.html
print guide/cover.html .cover.pdf
merge >/dev/null
rm -f .body.pdf .cover.pdf
echo "EN starts p.$EN, VI starts p.$VI"
