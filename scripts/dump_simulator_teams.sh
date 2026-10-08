#!/usr/bin/env bash
# Dump real gen9randombattle teams from the simulator for the stat tests to
# check against. Needs node. Writes tests/fixtures/simulator_teams.json.
set -euo pipefail

COUNT="${1:-400}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
echo '{"name":"simdump","private":true}' > package.json
npm install --silent --no-audit --no-fund pokemon-showdown

cat > dump.js <<'JS'
// Dump both the teams and the simulator's OWN copy of the random battle sets.
// Our live data tracks the current ladder while an npm release is a snapshot, so
// the two drift apart whenever the format is rebalanced. Capturing the snapshot's
// sets lets the tests tell a real arithmetic bug apart from that drift.
const {Teams, Dex} = require('pokemon-showdown');
const n = parseInt(process.argv[2] || '400', 10);
const out = [];
for (let i = 0; i < n; i++) {
  for (const set of Teams.generate('gen9randombattle')) {
    out.push({
      species: set.species,
      speciesId: Dex.forGen(9).species.get(set.species).id,
      level: set.level,
      ability: set.ability,
      item: set.item,
      moves: set.moves,
      teraType: set.teraType,
      evs: set.evs,
      ivs: set.ivs,
      nature: set.nature || 'Serious',
      role: set.role,
    });
  }
}
const sets = require('pokemon-showdown/data/random-battles/gen9/sets.json');
process.stdout.write(JSON.stringify({
  simulatorVersion: require('pokemon-showdown/package.json').version,
  teams: out,
  sets,
}));
JS

node dump.js "$COUNT" > "$ROOT/tests/fixtures/simulator_teams.json"
node -e "
const f = require('$ROOT/tests/fixtures/simulator_teams.json');
console.log(\`wrote \${f.teams.length} sets from $COUNT teams, plus the set data from simulator \${f.simulatorVersion}\`);
"
