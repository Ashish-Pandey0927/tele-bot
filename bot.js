// Telegram MCQ quiz bot: native quiz polls, 30s timer, auto reveal.
// Setup: npm init -y && npm install telegraf dotenv
// Run:   node bot.js   (BOT_TOKEN set in .env or the environment)
//
// Put two question banks next to this file:
//   questions_cs.txt  (your 80 CS questions)
//   questions_gs.txt  (your 40 GS questions)
// Same format for both:
//   प्र.1. question text        (or Q1. question text)
//   (A) option
//   (B) option
//   उत्तर: (B)                  (or Answer: (B))
//
// /quiz runs ALL CS questions (shuffled) first, then ALL GS questions (shuffled).

require('dotenv').config();

const fs = require('fs');
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
require('http')
  .createServer((req, res) => res.end('Bot is running'))
  .listen(process.env.PORT || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Telegram polls are plain text only (no LaTeX), so swap common math commands
// for readable symbols/text.
function cleanMath(text) {
  return text
    .replace(/\\lceil\s*/g, '⌈').replace(/\s*\\rceil/g, '⌉')
    .replace(/\\lfloor\s*/g, '⌊').replace(/\s*\\rfloor/g, '⌋')
    .replace(/\\log/g, 'log')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\le\b/g, '≤').replace(/\\ge\b/g, '≥')
    .replace(/\\bowtie/g, '⋈')
    .replace(/\\Pi\b/g, 'Π').replace(/\\sigma\b/g, 'σ')
    .replace(/\\/g, ''); // strip any leftover backslashes
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Parses blocks like:
// प्र.1. question text   OR   Q1. question text
// (A) option
// (B) option
// उत्तर: (B)   OR   Answer: (B)
function loadQuestions(file) {
  if (!fs.existsSync(file)) {
    console.warn(`Warning: ${file} not found, skipping.`);
    return [];
  }
  const raw = fs.readFileSync(file, 'utf8');
  // A new question starts at a line beginning with "प्र.N.", "QN." or just "N."
  return raw
    .split(/(?=^\s*(?:प्र\.\s*\d+\.|Q\.?\s*\d+\.|\d+\.)\s)/m)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const qLines = [];
      const options = [];
      let answer = null;
      for (const l of lines) {
        let m;
        if ((m = l.match(/^(?:उत्तर|Answer)\s*:\s*\(([A-D])\)/i))) {
          answer = m[1].toUpperCase().charCodeAt(0) - 65;
        } else if ((m = l.match(/^\(([A-D])\)\s*(.+)$/))) {
          options.push(cleanMath(m[2]));
        } else {
          qLines.push(
            cleanMath(l.replace(/^प्र\.\s*\d+\.\s*/, '').replace(/^Q\.?\s*\d+\.\s*/i, '').replace(/^\d+\.\s*/, ''))
          );
        }
      }
      if (!qLines.length || options.length < 2 || answer === null) return null;
      return { q: qLines.join('\n'), options, answer };
    })
    .filter(Boolean);
}

const csQuestions = loadQuestions('./questions_cs.txt');
const gsQuestions = loadQuestions('./questions_gs.txt');
console.log(`Loaded ${csQuestions.length} CS questions, ${gsQuestions.length} GS questions`);

const running = new Map(); // chatId -> true while a quiz is active
const polls = new Map();   // pollId -> { chatId, correct }
const boards = new Map();  // chatId -> Map(userId -> { name, score })

// Sends one shuffled-option poll for a question, tracks it, then waits out the timer.
async function sendQuestion(telegram, chatId, item, label) {
  const tagged = item.options.map((text, idx) => ({ text, ok: idx === item.answer }));
  const mixed = shuffle(tagged);
  const correct = mixed.findIndex((o) => o.ok);

  const msg = await telegram.sendPoll(
    chatId,
    `${label}: ${item.q}`.slice(0, 300),
    mixed.map((o) => o.text.slice(0, 100)),
    { type: 'quiz', correct_option_id: correct, open_period: 30, is_anonymous: false }
  );
  polls.set(msg.poll.id, { chatId, correct });
  await sleep(32000); // 30s poll + small gap before the next one
}

// Runs a full quiz session: all CS questions shuffled, then all GS questions shuffled.
async function runQuiz(telegram, chatId) {
  running.set(chatId, true);
  boards.set(chatId, new Map());

  const csSet = shuffle(csQuestions);
  const gsSet = shuffle(gsQuestions);
  const total = csSet.length + gsSet.length;
  let n = 0;

  if (csSet.length) {
    await telegram.sendMessage(chatId, `Starting CS round: ${csSet.length} questions.`);
    for (const item of csSet) {
      if (!running.get(chatId)) break;
      n++;
      await sendQuestion(telegram, chatId, item, `CS Q${n}/${total}`);
    }
  }

  if (running.get(chatId) && gsSet.length) {
    await telegram.sendMessage(chatId, `CS round done. Starting GS round: ${gsSet.length} questions.`);
    for (const item of gsSet) {
      if (!running.get(chatId)) break;
      n++;
      await sendQuestion(telegram, chatId, item, `GS Q${n}/${total}`);
    }
  }

  const board = [...(boards.get(chatId) || new Map()).values()].sort((a, b) => b.score - a.score);
  const text = board.length
    ? 'Quiz finished!\n\n' + board.map((p, i) => `${i + 1}. ${p.name}: ${p.score}`).join('\n')
    : 'Quiz finished!';
  await telegram.sendMessage(chatId, text);
  running.delete(chatId);
}

bot.start((ctx) =>
  ctx.reply(
    `Send /quiz to run all ${csQuestions.length} CS questions, then all ${gsQuestions.length} GS questions (both shuffled). Use /stop to end early.`
  )
);

bot.command('quiz', (ctx) => {
  const chatId = ctx.chat.id;
  if (running.has(chatId)) return ctx.reply('A quiz is already running. Use /stop to end it.');
  if (!csQuestions.length && !gsQuestions.length) return ctx.reply('No questions loaded. Check questions_cs.txt / questions_gs.txt on the server.');
  runQuiz(ctx.telegram, chatId).catch((e) => {
    console.error(e);
    running.delete(chatId);
  }); // not awaited on purpose, Telegraf handlers time out after 90s
});

bot.command('stop', (ctx) => {
  if (!running.has(ctx.chat.id)) return ctx.reply('No quiz is running.');
  running.set(ctx.chat.id, false);
  ctx.reply('Stopping after the current question.');
});

// Score tracking (needs is_anonymous: false)
bot.on('poll_answer', (ctx) => {
  const a = ctx.pollAnswer;
  const p = polls.get(a.poll_id);
  if (!p || a.option_ids[0] !== p.correct) return;
  const board = boards.get(p.chatId);
  if (!board) return;
  const cur = board.get(a.user.id) || { name: a.user.first_name, score: 0 };
  cur.score += 1;
  board.set(a.user.id, cur);
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));