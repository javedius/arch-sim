#!/usr/bin/env bash
# Сборка и публикация на GitHub Pages (ветка gh-pages)
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
BASE_PATH=/arch-sim/ npm run build
cd dist && touch .nojekyll && cp index.html 404.html
git init -q -b gh-pages && git add -A && git -c user.name=javedius -c user.email=javedius@users.noreply.github.com commit -qm "Deploy $(date -u +%FT%TZ)"
git push -q -f "$(cd .. && git remote get-url origin)" gh-pages
rm -rf .git
echo "Готово: https://javedius.github.io/arch-sim/"
