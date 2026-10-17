import "dotenv/config";
import { App } from "@slack/bolt";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishToX } from "./x-publisher.js";
import { publishToLinkedIn } from "./linkedin-publisher.js";

// 1. Connect the bot to Slack using your existing credentials.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

// Temporary: log every incoming Slack event to debug direct messages.
app.use(async ({ body, next }) => {
  const event = body.event;
  console.log(
    "Slack sent:",
    body.type ?? body.command,
    event
      ? `${event.type} subtype=${event.subtype ?? "-"} channel_type=${event.channel_type ?? "-"} files=${event.files?.length ?? 0}`
      : ""
  );
  await next();
});

// 2. Keep posts awaiting confirmation in memory.
const pendingPosts = new Map();

const PLATFORM_NAMES = { x: "X", linkedin: "LinkedIn" };
const PLATFORM_CHOICES = {
  x: ["x"],
  linkedin: ["linkedin"],
  both: ["x", "linkedin"],
};

// File types both X and LinkedIn accept, with the largest size X allows.
const MEDIA_LIMITS = {
  "video/mp4": { kind: "video", maxBytes: 500 * 1024 * 1024 },
  "video/quicktime": { kind: "video", maxBytes: 500 * 1024 * 1024 },
  "image/jpeg": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "image/png": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "image/gif": { kind: "GIF", maxBytes: 15 * 1024 * 1024 },
};

const USAGE =
  "Send me a direct message like `x | Your post`, `linkedin | Your post` or `both | Your post`. " +
  "Attach one JPG, PNG, GIF or MP4 to include it in the post.\n" +
  "From any other channel, use `/publish both | Your post` (text only).";

// 3. Split "platform | text" into the platforms and the post text.
function parsePostRequest(input) {
  const separatorIndex = input.indexOf("|");

  if (separatorIndex === -1) {
    return { error: USAGE };
  }

  const choice = input.slice(0, separatorIndex).trim().toLowerCase();
  const text = input.slice(separatorIndex + 1).trim();
  const platforms = PLATFORM_CHOICES[choice];

  if (!platforms) {
    return { error: "Choose `x`, `linkedin` or `both` as the publishing platform." };
  }

  if (!text) {
    return { error: "Please enter some text for your post." };
  }

  return { platforms, text };
}

// 4. Build the preview message with a confirmation button.
function buildPreview(postId, pending) {
  const names = pending.platforms.map((p) => PLATFORM_NAMES[p]).join(" and ");
  const mediaLine = pending.media
    ? `\n*Attachment:* ${pending.media.name}`
    : "\n_Text only. To include an image or video, send it to me as a normal message (not /publish) with `both | your text`._";

  return {
    text: `Review your ${names} post before publishing.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Platform:* ${names}${mediaLine}\n\n*Post preview:*\n${pending.text}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: `Publish to ${names}` },
            style: "primary",
            action_id: "confirm_publish",
            value: postId,
            confirm: {
              title: { type: "plain_text", text: "Confirm publishing" },
              text: { type: "mrkdwn", text: `Publish this post to ${names}?` },
              confirm: { type: "plain_text", text: "Publish" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      },
    ],
  };
}

// 5. Download a Slack file to a temporary folder.
async function downloadSlackFile(file, postId) {
  const response = await fetch(file.url_private_download, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });

  // Slack returns its login page instead of the file if files:read is missing.
  if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(
      `Could not download the file from Slack (${response.status}). Make sure the bot has the files:read scope.`
    );
  }

  const extension = path.extname(file.name) || ".mp4";
  const filePath = path.join(os.tmpdir(), `social-publisher-${postId}${extension}`);

  await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));

  return filePath;
}

// 6. A simple command to check whether the bot is responding.
app.command("/hello", async ({ ack, respond }) => {
  await ack();
  await respond("Hello! Your Slack bot is running.");
});

// 7. Accept text-only commands such as:
// /publish x | Hello X
// /publish linkedin | Hello LinkedIn
// /publish both | Hello everyone
app.command("/publish", async ({ command, ack, respond }) => {
  await ack();

  const request = parsePostRequest(command.text);

  if (request.error) {
    await respond(request.error);
    return;
  }

  const postId = crypto.randomUUID();
  const pending = {
    platforms: request.platforms,
    text: request.text,
    userId: command.user_id,
  };

  pendingPosts.set(postId, pending);

  await respond({ response_type: "ephemeral", ...buildPreview(postId, pending) });
});

// 8. Accept a direct message to the bot, optionally with an image or video, with
//    "x | text", "linkedin | text" or "both | text" as the message.
app.message(async ({ message, say }) => {
  // Only handle new messages in direct messages with the bot.
  if (message.channel_type !== "im") return;
  if (message.subtype && message.subtype !== "file_share") return;

  console.log(
    `Direct message received (${message.files?.length ?? 0} file(s): ${
      message.files?.map((file) => file.mimetype).join(", ") || "none"
    })`
  );

  const request = parsePostRequest(message.text ?? "");

  if (request.error) {
    await say(request.error);
    return;
  }

  const file = message.files?.find((f) => MEDIA_LIMITS[f.mimetype]);

  if (message.files?.length && !file) {
    await say("I can only post JPG, PNG, GIF or MP4 files.");
    return;
  }

  // No attachment: preview a text-only post.
  if (!file) {
    const postId = crypto.randomUUID();
    const pending = {
      platforms: request.platforms,
      text: request.text,
      userId: message.user,
    };

    pendingPosts.set(postId, pending);
    await say(buildPreview(postId, pending));
    return;
  }

  const limit = MEDIA_LIMITS[file.mimetype];

  if (file.size > limit.maxBytes) {
    await say(
      `That ${limit.kind} is larger than ${limit.maxBytes / 1024 / 1024} MB, which X doesn't accept.`
    );
    return;
  }

  const postId = crypto.randomUUID();

  try {
    const mediaPath = await downloadSlackFile(file, postId);
    const pending = {
      platforms: request.platforms,
      text: request.text,
      userId: message.user,
      media: { path: mediaPath, name: file.name, mimetype: file.mimetype },
    };

    pendingPosts.set(postId, pending);
    console.log(`File downloaded (${file.name}), preview sent.`);

    await say(buildPreview(postId, pending));
  } catch (error) {
    console.error("Preparing the file failed:", error.message);
    await say(error.message);
  }
});

// 9. Publish only after the user confirms.
app.action("confirm_publish", async ({ ack, body, action, respond }) => {
  await ack();

  const postId = action.value;
  const pending = pendingPosts.get(postId);

  // 10. Reject missing posts or clicks from a different user.
  if (!pending || pending.userId !== body.user.id) {
    await respond({
      response_type: "ephemeral",
      text: "This post is no longer available. Please create a new preview.",
      replace_original: false,
    });
    return;
  }

  // 11. Remove it so the same preview cannot be published twice.
  pendingPosts.delete(postId);

  await respond({
    replace_original: true,
    text: pending.media
      ? "Uploading your file and publishing. Videos can take a few minutes…"
      : "Publishing…",
  });

  // 12. Publish to each selected platform and collect the results.
  const results = [];

  for (const platform of pending.platforms) {
    const name = PLATFORM_NAMES[platform];
    console.log(`Publishing to ${name}${pending.media ? ` with ${pending.media.mimetype}` : ""}…`);
    const options = pending.media
      ? { mediaPath: pending.media.path, mediaType: pending.media.mimetype }
      : {};

    try {
      const result =
        platform === "x"
          ? await publishToX(pending.text, options)
          : await publishToLinkedIn(pending.text, options);

      const postIdFromResult = result?.id ?? result?.postId ?? result?.data?.id;

      results.push(
        `✅ Published to ${name}!${postIdFromResult ? ` Post ID: ${postIdFromResult}` : ""}`
      );
    } catch (error) {
      // Report the error without printing secrets.
      console.error(`Publishing to ${platform} failed:`, error.message);
      results.push(`❌ Publishing to ${name} failed. Check your terminal for the error details.`);
    }
  }

  // 13. Delete the temporary file.
  if (pending.media) {
    await fs.rm(pending.media.path, { force: true });
  }

  await respond({ replace_original: true, text: results.join("\n") });
});

// 14. Start the Slack bot, unless another copy is already running.
//     Two copies would each get some of Slack's events, so a preview
//     shown by one copy could not be published by the other.
const pidFile = path.join(path.dirname(new URL(import.meta.url).pathname), ".bot.pid");

try {
  const otherPid = Number(await fs.readFile(pidFile, "utf8"));
  process.kill(otherPid, 0);
  console.error(
    `The bot is already running (process ${otherPid}). Stop it with Ctrl+C in its terminal, or run: kill ${otherPid}`
  );
  process.exit(1);
} catch {
  // No other copy is running.
}

await fs.writeFile(pidFile, String(process.pid));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await fs.rm(pidFile, { force: true });
    process.exit(0);
  });
}

(async () => {
  await app.start();
  console.log("Slack bot is running!");
})();
