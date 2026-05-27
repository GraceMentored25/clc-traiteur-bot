import TelegramBot from "node-telegram-bot-api";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = "GraceMentored25/clc-traiteur-dashboard";
const GITHUB_BRANCH = "main";
const ALLOWED_USER = process.env.ALLOWED_TELEGRAM_USER; // optional whitelist

async function askBedrockClaude(prompt) {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const response = await fetch(
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-5/invoke",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Bedrock error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.content[0].text;
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const SYSTEM_PROMPT = `Tu es un assistant développeur expert sur le projet C.LC. Traiteur Dashboard.

## Projet
- Repo GitHub : https://github.com/GraceMentored25/clc-traiteur-dashboard
- Stack : Next.js 15, TypeScript, Tailwind CSS, Zustand, Recharts, Framer Motion
- App dans : clc-traiteur-pos/
- URL production : https://clc-traiteur-dashboard.vercel.app

## Ton rôle
L'utilisateur t'envoie des instructions de modification via Telegram.
Tu dois :
1. Identifier le(s) fichier(s) à modifier
2. Générer le code modifié COMPLET du fichier
3. Répondre avec le format exact suivant :

<file path="clc-traiteur-pos/src/...">
// contenu complet du fichier
</file>

<summary>
Ce que tu as changé en 1-2 phrases.
</summary>

IMPORTANT :
- Toujours inclure le contenu COMPLET du fichier, jamais partiel
- Un seul fichier par modification si possible
- Ne jamais modifier package.json, next.config.ts, tsconfig.json sauf si explicitement demandé
- Garder le style de code existant (TypeScript strict, Tailwind classes, etc.)`;


function parseResponse(text) {
  const files = [];
  const fileRegex = /<file path="([^"]+)">([\s\S]*?)<\/file>/g;
  let match;
  while ((match = fileRegex.exec(text)) !== null) {
    files.push({ path: match[1], content: match[2].trim() });
  }
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  const summary = summaryMatch ? summaryMatch[1].trim() : "Modification effectuée.";
  return { files, summary };
}

function cloneAndPush(files, commitMessage) {
  const tmpDir = join(tmpdir(), `clc-bot-${Date.now()}`);
  try {
    // Clone
    execSync(
      `git clone https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git ${tmpDir} --depth=1 --branch=${GITHUB_BRANCH}`,
      { stdio: "pipe" }
    );

    // Apply file changes
    for (const { path, content } of files) {
      const fullPath = join(tmpDir, path);
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/") !== -1 ? fullPath.lastIndexOf("/") : fullPath.lastIndexOf("\\"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content, "utf8");
    }

    // Commit & push
    execSync(`git -C ${tmpDir} config user.email "bot@clc-traiteur.app"`, { stdio: "pipe" });
    execSync(`git -C ${tmpDir} config user.name "CLC Bot"`, { stdio: "pipe" });
    execSync(`git -C ${tmpDir} add -A`, { stdio: "pipe" });
    execSync(`git -C ${tmpDir} commit -m "${commitMessage}"`, { stdio: "pipe" });
    execSync(`git -C ${tmpDir} push origin ${GITHUB_BRANCH}`, { stdio: "pipe" });

    return true;
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text || text === "/start") {
    bot.sendMessage(chatId,
      "👋 Bonjour ! Je suis le bot C.LC. Traiteur.\n\nEnvoie-moi une instruction de modification et je m'occupe du code + du push automatique.\n\nExemple : _\"Change la couleur du bouton panier en bleu\"_",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Optional whitelist check
  if (ALLOWED_USER && String(msg.from?.id) !== ALLOWED_USER) {
    bot.sendMessage(chatId, "⛔ Accès non autorisé.");
    return;
  }

  const thinking = await bot.sendMessage(chatId, "⏳ Analyse en cours...");

  try {
    const claudeResponse = await askBedrockClaude(text);
    const { files, summary } = parseResponse(claudeResponse);

    if (files.length === 0) {
      await bot.editMessageText(
        `💬 ${claudeResponse.replace(/<[^>]+>/g, "").trim().slice(0, 4000)}`,
        { chat_id: chatId, message_id: thinking.message_id }
      );
      return;
    }

    await bot.editMessageText("⚙️ Application des modifications...", {
      chat_id: chatId,
      message_id: thinking.message_id,
    });

    const commitMsg = `bot: ${summary.slice(0, 72)}`;
    cloneAndPush(files, commitMsg);

    const fileList = files.map((f) => `• \`${f.path}\``).join("\n");
    await bot.editMessageText(
      `✅ *Pushé sur main !*\n\n${summary}\n\n*Fichiers modifiés :*\n${fileList}\n\n🚀 Vercel redéploie automatiquement.`,
      { chat_id: chatId, message_id: thinking.message_id, parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await bot.editMessageText(`❌ Erreur : ${err.message?.slice(0, 300)}`, {
      chat_id: chatId,
      message_id: thinking.message_id,
    });
  }
});

console.log("🤖 CLC Traiteur Bot démarré");
