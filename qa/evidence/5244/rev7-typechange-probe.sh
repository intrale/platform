#!/bin/sh
# #5244 rev-7 — reproduce el bypass por typechange (T) en los DOS modos.
# AISLAMIENTO DURO: todo con `git -C <tmp>`, nunca `cd`. Nada toca el repo real.
# El fixture se arma por concatenacion: no hay literal de credencial en el repo.
set -u
SCANNER="$1"
KEY="AKIA""IOSFODNN7""EXAMPLE"
SEC='aws_access_key_id = '"$KEY"
# mask(): enmascara la credencial del fixture y neutraliza la marca de supresion
# que el propio texto de ayuda del scanner imprime (si no, esta evidencia se
# auto-suprime lineas al pasar por el gate y ensucia el PR con warnings).
MARCA="secret-""scan:ignore"
mask() { sed -e "s/$KEY/AKIA<...>/g" -e "s/$MARCA/<MARCA-DE-SUPRESION>/g"; }

init() { R=$(mktemp -d); git -C "$R" init -q; git -C "$R" config user.email t@t.invalid;
         git -C "$R" config user.name T; echo base > "$R/seed.txt";
         git -C "$R" add -A >/dev/null 2>&1; git -C "$R" commit -qm seed >/dev/null 2>&1; echo "$R"; }

echo "########## A — symlink(120000) -> archivo regular · modo STAGED (pre-commit) ##########"
A=$(init)
BLOB=$(printf 'some/target' | git -C "$A" hash-object -w --stdin)
git -C "$A" update-index --add --cacheinfo 120000,"$BLOB",creds.txt
git -C "$A" commit -qm link >/dev/null 2>&1
printf '%s\n' "$SEC" > "$A/creds.txt"
git -C "$A" add -A >/dev/null 2>&1
echo "-- git diff --cached --name-status --"; git -C "$A" diff --cached --name-status
echo "-- numstat bajo el filtro VIEJO (ACMR), diagnostico --"
git -C "$A" diff --cached --numstat --diff-filter=ACMR; echo "-- (fin) --"
node "$SCANNER" --mode=staged --cwd="$A" --format=text > "$A/out" 2>&1; echo "STAGED_EXIT=$?"; mask < "$A/out"

echo
echo "########## B — gitlink(160000) -> archivo regular · modo RANGE (CI) ##########"
B=$(init)
SHA=$(git -C "$B" rev-parse HEAD)
git -C "$B" update-index --add --cacheinfo 160000,"$SHA",vendor
git -C "$B" commit -qm gitlink >/dev/null 2>&1
BASE=$(git -C "$B" rev-parse HEAD)
git -C "$B" rm -q --cached vendor
printf '%s\n' "$SEC" > "$B/vendor"
git -C "$B" add -f vendor >/dev/null 2>&1
git -C "$B" commit -qm typechange >/dev/null 2>&1
HEAD_SHA=$(git -C "$B" rev-parse HEAD)
echo "-- name-status BASE..HEAD (sin filtro) --"; git -C "$B" diff --name-status "$BASE..$HEAD_SHA"
echo "-- numstat bajo el filtro VIEJO (ACMR), diagnostico --"
git -C "$B" diff "$BASE..$HEAD_SHA" --numstat --diff-filter=ACMR; echo "-- (fin) --"
node "$SCANNER" --mode=range --base="$BASE" --head="$HEAD_SHA" --cwd="$B" --format=text > "$B/out" 2>&1; echo "RANGE_EXIT=$?"; mask < "$B/out"
echo "-- el secreto quedo en el arbol del head: --"; git -C "$B" show "$HEAD_SHA:vendor" | mask

echo
echo "########## C — NO-REGRESION: commit benigno debe seguir en verde ##########"
C=$(init)
printf 'hola mundo\n' > "$C/nota.txt"; git -C "$C" add -A >/dev/null 2>&1
node "$SCANNER" --mode=staged --cwd="$C" --format=text; echo "BENIGNO_EXIT=$?"

echo
echo "########## D — NO-REGRESION: borrado de binario no debe romper ##########"
D=$(init)
printf 'PNG\000\001\002binario\n' > "$D/logo.png"; git -C "$D" add -A >/dev/null 2>&1
git -C "$D" commit -qm bin >/dev/null 2>&1
DBASE=$(git -C "$D" rev-parse HEAD)
git -C "$D" rm -q "$D/logo.png"; git -C "$D" commit -qm "borra bin" >/dev/null 2>&1
DHEAD=$(git -C "$D" rev-parse HEAD)
node "$SCANNER" --mode=range --base="$DBASE" --head="$DHEAD" --cwd="$D" --format=text; echo "DELBIN_EXIT=$?"
