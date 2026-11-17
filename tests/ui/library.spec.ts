import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
test("browse, full-text search, change folder, star, transfer and import without losing selection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Conversations", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /First café/ })).toBeVisible();
  await page.getByRole("button", { name: /First café/ }).click();
  await expect(page.locator(".message-text").last()).toContainText(
    "User message 306",
  );
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.locator(".message-text").first()).toContainText(
    "Assistant message 107",
  );
  await page
    .getByLabel("Search conversations", { exact: true })
    .fill("needle mango");
  await expect(page.locator(".chat-row")).toHaveCount(1);
  await page.getByLabel("Clear search").click();
  await page
    .getByRole("button", { name: "Star conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unstar conversation", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const folder = resolve(".test-data/new-working-folder");
  await mkdir(folder, { recursive: true });
  await page.getByRole("dialog").locator(".path-field input").fill(folder);
  await page.getByRole("button", { name: "Save folder" }).click();
  await expect(page.locator(".working-folder")).toContainText(folder);
  await expect(page.locator(".original-folder")).toBeVisible();
  await page.getByLabel("Select First café 日本語", { exact: true }).check();
  await page.getByRole("button", { name: "Export 1", exact: true }).click();
  const dest = resolve(".test-data/UI-USB");
  await mkdir(dest, { recursive: true });
  await page.getByRole("dialog").locator(".path-field input").fill(dest);
  await page.getByRole("button", { name: "Create archive" }).click();
  await page.getByRole("button", { name: /Transfers/ }).click();
  await expect(page.locator(".job-card.completed")).toHaveCount(1, {
    timeout: 30000,
  });
  const archive = await page.locator(".job-path").first().innerText();
  expect(archive).toMatch(/\.chatport.zip$/);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("dialog").locator(".path-field input").fill(archive);
  await page
    .getByRole("button", { name: "Import conversations", exact: true })
    .click();
  await expect(page.locator(".job-card.completed")).toHaveCount(2, {
    timeout: 30000,
  });
  await page.getByRole("button", { name: /^Imported/ }).click();
  await expect(page.locator(".chat-row")).toHaveCount(1);
  await page.locator(".chat-main").click();
  await expect(page.locator(".message-text").last()).toContainText(
    "User message 306",
  );
  await expect(page.locator(".working-folder")).toContainText(folder);
  expect(errors).toEqual([]);
  await page.screenshot({ path: ".test-data/chatport-ui.png", fullPage: true });
});
test("source controls, keyboard search, and 960px layout stay usable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Manage sources").click();
  await expect(
    page.getByRole("heading", { name: "Sources & integrations" }),
  ).toBeVisible();
  await expect(page.getByText("MIT · open source")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(
    page.getByLabel("Search conversations", { exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 960, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    960,
  );
  await expect(
    page.getByRole("button", { name: "Export all", exact: true }),
  ).toBeVisible();
});
test("system theme, status markers, live edits, pause, scrolling, image modal and provider logos", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Manage sources").click();
  await expect(page.getByLabel("Appearance")).toHaveValue("system");
  await page.getByLabel("Appearance").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Appearance").selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  async function call(method: string, params: any = {}) {
    return page.evaluate(
      async ({ method, params }) => {
        const c = await (await fetch("/__bootstrap")).json();
        const r = await fetch(`http://127.0.0.1:${c.port}/rpc`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + c.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ method, params }),
        });
        return (await r.json()).result;
      },
      { method, params },
    );
  }
  const library = await call("library"),
    source = library.sources.find(
      (s: any) => s.provider === "codex" && !s.imported,
    ),
    chat = library.chats.find(
      (c: any) =>
        c.sourceId === source.id &&
        c.nativeId === "11111111-1111-4111-8111-111111111111",
    );
  expect(source.root).toContain(".test-data");
  await page.locator(`[data-chat-id="${chat.id}"] .chat-main`).click();
  await expect(page.getByLabel("Live updates", { exact: true })).toBeChecked();
  const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7RwAAAAASUVORK5CYII=",
      "base64",
    ),
    imagePath = join(source.root, "Screenshot-ui.png");
  await writeFile(imagePath, png);
  const h = new DatabaseSync(join(source.root, "thread_history_1.sqlite"));
  h.prepare(
    "UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE thread_id=? AND item_id=?",
  ).run(
    JSON.stringify({
      type: "userMessage",
      content: [
        { type: "text", text: "User message 306 with screenshot" },
        { type: "localImage", path: imagePath },
      ],
    }),
    307,
    chat.nativeId,
    "item-306",
  );
  h.prepare("UPDATE thread_turns SET status=? WHERE thread_id=?").run(
    "inProgress",
    chat.nativeId,
  );
  await expect(page.locator(".reader-kicker .activity-badge")).toHaveText(
    "Unfinished",
    { timeout: 12000 },
  );
  await expect(
    page.getByRole("button", { name: "Open image Screenshot-ui.png" }),
  ).toBeVisible({ timeout: 12000 });
  await page
    .getByRole("button", { name: "Open image Screenshot-ui.png" })
    .click();
  const modal = page.getByRole("dialog", {
    name: "Image Screenshot-ui.png",
    exact: true,
  });
  await expect(modal.locator(".image-canvas img")).toBeVisible();
  expect(
    await modal
      .locator(".image-canvas img")
      .evaluate((img: any) => img.naturalWidth),
  ).toBe(1);
  const download = page.waitForEvent("download");
  await modal.getByRole("button", { name: "Save image" }).click();
  expect((await download).suggestedFilename()).toBe("Screenshot-ui.png");
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  h.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)").run(
    chat.nativeId,
    "turn",
    "live-item",
    400,
    Date.now(),
    "agentMessage",
    JSON.stringify({ type: "agentMessage", text: "Live response one" }),
    400,
  );
  await expect(page.locator(".message-text").last()).toHaveText(
    "Live response one",
    { timeout: 12000 },
  );
  h.prepare(
    "UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE item_id=?",
  ).run(
    JSON.stringify({ type: "agentMessage", text: "Live response edited" }),
    401,
    "live-item",
  );
  await expect(page.locator(".message-text").last()).toHaveText(
    "Live response edited",
    { timeout: 12000 },
  );
  await page.getByLabel("Live updates", { exact: true }).uncheck();
  h.prepare(
    "UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE item_id=?",
  ).run(
    JSON.stringify({ type: "agentMessage", text: "Changed while paused" }),
    402,
    "live-item",
  );
  await expect
    .poll(
      async () =>
        (await call("library")).chats.find((c: any) => c.id === chat.id)
          .activity.revision,
    )
    .toContain("402");
  await expect(page.locator(".message-text").last()).toHaveText(
    "Live response edited",
  );
  await page.getByLabel("Live updates", { exact: true }).check();
  await expect(page.locator(".message-text").last()).toHaveText(
    "Changed while paused",
    { timeout: 12000 },
  );
  await page.locator(".message-scroll").evaluate((e) => (e.scrollTop = 0));
  h.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)").run(
    chat.nativeId,
    "turn",
    "live-403",
    403,
    Date.now(),
    "agentMessage",
    JSON.stringify({
      type: "agentMessage",
      text: "New response while reading older messages",
    }),
    403,
  );
  await expect(page.locator(".message-text").last()).toHaveText(
    "New response while reading older messages",
    { timeout: 12000 },
  );
  expect(
    await page.locator(".message-scroll").evaluate((e) => e.scrollTop),
  ).toBeLessThan(90);
  await page.getByRole("button", { name: "Jump to latest messages" }).click();
  for (const name of [
    "Codex",
    "Claude Code",
    "OpenCode",
    "T3 Code",
    "ChatGPT",
    "Freebuff",
  ])
    await expect(
      page.locator(".sidebar").getByAltText(name + " logo"),
    ).toBeVisible();
  await expect(page.getByText("Your conversations, together.")).toHaveCount(0);
  await page.getByLabel("Manage sources").click();
  await page.getByLabel("Appearance").selectOption("dark");
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: ".test-data/chatport-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  h.close();
});
