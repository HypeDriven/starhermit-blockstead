// Prints play-script steps that build a stage to its end by the keyboard, as
// the rules' greedy hint solver plays it (tests/run-tests.js's `solve`):
// each hinted placement is the block's number key, the arrow presses that
// move the target cursor from the first legal tile to the hinted one (the
// cursor walks the legal tiles row by row, as Rules.legalTargets lists
// them) and Enter; a hinted (or needed) gather is G. Paste the output into a
// tests/native/*.play script.
//   node tools/plan.mjs j01            (a Journey stage, challenge c1…, practice casual…, lesson t3…, score)
//   node tools/plan.mjs j01 --max 12   (at most 12 actions)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const Session = require('../js/session.js');

const args = process.argv.slice(2);
const id = args[0] || 'j01';
const max = Number(args[args.indexOf('--max') + 1]) || (args.includes('--max') ? 0 : 600);
const all = [].concat(Content.JOURNEY, Content.CHALLENGES, Content.PRACTICE, [Content.SCORE_CHASE], Content.tutorialLessons().map((l) => l.cfg));
const cfg = id === 'score' ? Content.SCORE_CHASE : all.find((c) => c.id === id);
if (!cfg) { console.error('unknown stage ' + id); process.exit(1); }

const sess = Session.createSession(cfg);
const out = [`# ${id} by the greedy hint solver (tools/plan.mjs)`];
const key = (code) => { out.push(`key ${code} 2`, 'frames 6'); };
let n = 0;
while (!sess.terminal && n++ < max) {
  const h = Rules.hint(sess.state);
  if (!h) break;
  let cmd = h;
  if (h.type === 'place') {
    const targets = Rules.legalTargets(sess.state, h.block);
    const idx = targets.findIndex((c) => c.x === h.x && c.y === h.y);
    const res = Session.execute(sess, h, n * 100);
    if (!res.ok || idx < 0) { cmd = { type: 'gather' }; }
    else {
      key('Digit' + (cfg.blocks.indexOf(h.block) + 1));
      for (let i = 0; i < idx; i++) key('ArrowRight');
      key('Enter');
      continue;
    }
  }
  if (cmd.type === 'gather' || h.type === 'gather') {
    const g = Session.execute(sess, { type: 'gather' }, n * 100);
    if (!g.ok) break;
    key('KeyG');
  }
}
out.push(`# ${sess.terminal ? (sess.terminal.won ? 'won' : 'lost: ' + sess.terminal.reason) : 'unfinished'} in ${sess.state.moves} moves, score ${sess.state.score.total}`);
console.log(out.join('\n'));
