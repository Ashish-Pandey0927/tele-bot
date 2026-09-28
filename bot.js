// Telegram MCQ quiz bot: native quiz polls, 30s timer, auto reveal.
// Setup: npm init -y && npm install telegraf
// Run:   BOT_TOKEN=your_token node bot.js
// Put your questions in questions.txt (UTF-8) next to this file.

require('dotenv').config();

const fs = require('fs');
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Parses blocks like:
// प्र.1. question text
// (A) option
// (B) option
// उत्तर: (B)
function loadQuestions(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split(/(?=प्र\.\s*\d+\.)/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const qLines = [];
      const options = [];
      let answer = null;
      for (const l of lines) {
        let m;
        if ((m = l.match(/^उत्तर:\s*\(([A-D])\)/))) {
          answer = m[1].charCodeAt(0) - 65;
        } else if ((m = l.match(/^\(([A-D])\)\s*(.+)$/))) {
          options.push(m[2]);
        } else {
          qLines.push(l.replace(/^प्र\.\s*\d+\.\s*/, ''));
        }
      }
      if (!qLines.length || options.length < 2 || answer === null) return null;
      return { q: qLines.join(' '), options, answer };
    })
    .filter(Boolean);
}

const questions = loadQuestions('./questions.txt');
console.log(`Loaded ${questions.length} questions`);

const running = new Map(); // chatId -> true while a quiz is active
const polls = new Map();   // pollId -> { chatId, correct }
const boards = new Map();  // chatId -> Map(userId -> { name, score })

async function runQuiz(telegram, chatId, count) {
  const set = shuffle(questions).slice(0, count);
  running.set(chatId, true);
  boards.set(chatId, new Map());

  for (let i = 0; i < set.length; i++) {
    if (!running.get(chatId)) break;

    // Shuffle options so the right answer is not always in the same slot
    const tagged = set[i].options.map((text, idx) => ({ text, ok: idx === set[i].answer }));
    const mixed = shuffle(tagged);
    const correct = mixed.findIndex((o) => o.ok);

    const msg = await telegram.sendPoll(
      chatId,
      `Q${i + 1}/${set.length}: ${set[i].q}`.slice(0, 300),
      mixed.map((o) => o.text.slice(0, 100)),
      { type: 'quiz', correct_option_id: correct, open_period: 30, is_anonymous: false }
    );
    polls.set(msg.poll.id, { chatId, correct });

    await sleep(32000); // 30s poll + small gap before the next one
  }

  const board = [...(boards.get(chatId) || new Map()).values()].sort((a, b) => b.score - a.score);
  const text = board.length
    ? 'Quiz finished!\n\n' + board.map((p, i) => `${i + 1}. ${p.name}: ${p.score}`).join('\n')
    : 'Quiz finished!';
  await telegram.sendMessage(chatId, text);
  running.delete(chatId);
}

bot.start((ctx) => ctx.reply('Send /quiz to start (default 10 questions) or /quiz 20 for 20. Use /stop to end.'));

bot.command('quiz', (ctx) => {
  const chatId = ctx.chat.id;
  if (running.get(chatId)) return ctx.reply('A quiz is already running. Use /stop to end it.');
  const n = Math.min(parseInt(ctx.message.text.split(' ')[1]) || 10, questions.length);
  runQuiz(ctx.telegram, chatId, n).catch((e) => {
    console.error(e);
    running.delete(chatId);
  }); // not awaited on purpose, Telegraf handlers time out after 90s
});

bot.command('stop', (ctx) => {
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