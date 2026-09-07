async (page) => {
  // Replace with a TemporaryDirectory MemoryStore fixture; every API stays mocked.
  const fixture = /* SYNTHETIC_MEMORY_FIXTURE */ null;
  if (!fixture) throw new Error("Synthetic MemoryStore fixture required");
  const errors = [], requests = [], checks = [];
  let memories = [], serial = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = request.method(), payload = method === "GET" ? null : request.postDataJSON();
    requests.push({ path, method, payload });
    let result;
    if (method === "GET" && path === "/api/parent/dashboard") {
      result = JSON.parse(JSON.stringify(fixture.dashboard));
      result.memories = memories;
      result.growth_journal[0].milestones = memories.filter(item => item.category === "episodic" && item.status === "durable").map(item => item.summary);
    } else if (method === "GET" && path === "/api/memories") result = { memories };
    else if (method === "GET" && path === "/api/parent/messages") result = { messages: [] };
    else if (method === "POST" && path === "/api/memories") {
      result = { ...payload, id: `synthetic-added-${++serial}`, created_at: "2026-09-06T06:00:00Z" }; memories.push(result);
    } else if (method === "PATCH" && path.startsWith("/api/memories/")) {
      const item = memories.find(item => path.endsWith("/" + item.id));
      if (item) { Object.assign(item, payload); result = item; }
    }
    if (!result) { errors.push(`Blocked unexpected API ${method} ${path}`); return route.fulfill({ status: 403, body: "QA blocked" }); }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
  });
  try {
    for (const size of [{ width: 1400, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
      memories = JSON.parse(JSON.stringify(fixture.memories));
      await page.setViewportSize(size); await page.goto("http://127.0.0.1:8760/parent");
      await page.waitForFunction(() => document.querySelectorAll(".memory-item").length === 4);
      if (!await page.locator("#memoryCategory").count()) {
        checks.push({ width: size.width, pass: false, reason: "No memory category selector: a parent cannot add a milestone" }); break;
      }
      const summary = `第一次独立数到二十 <img src=x onerror=alert(1)> ${size.width}`;
      await page.locator("#memoryInput").fill(summary);
      await page.locator("#memoryCategory").selectOption("episodic");
      await page.locator('#memoryForm button[type="submit"]').click();
      await page.waitForFunction(value => document.querySelector("#journalContent").textContent.includes(value), summary);
      const escaped = await page.locator("#journalContent img").count() === 0;
      const preserved = [];
      for (const category of ["parent", "profile", "learning", "interest"]) {
        const item = page.locator(".memory-item").filter({ hasText: `分类保留测试-${category}` });
        await item.getByRole("button", { name: "纠正", exact: true }).click();
        const selector = item.getByLabel("记忆分类");
        preserved.push((await selector.inputValue()) === category);
        await item.getByLabel("纠正记忆内容").fill(`分类保留测试-${category}-已纠正`);
        await item.getByRole("button", { name: "保存纠正", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector(".inline-editor"));
      }
      const oldParent = page.locator(".memory-item").filter({ hasText: "分类保留测试-parent-已纠正" });
      await oldParent.getByRole("button", { name: "纠正", exact: true }).click();
      await oldParent.getByLabel("记忆分类").selectOption("episodic");
      await oldParent.getByRole("button", { name: "保存纠正", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#journalContent").textContent.includes("已确认的成长记录：分类保留测试-parent-已纠正"));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      await page.locator("#memoryForm").scrollIntoViewIfNeeded();
      const screenshot = `output/playwright/parent-memory-categories-${size.width}.png`;
      await page.screenshot({ path: screenshot });
      const categoriesPreserved = memories.filter(item => /分类保留测试-(profile|learning|interest)/.test(item.summary))
        .every(item => item.summary.includes(`-${item.category}-`));
      checks.push({ ...size, escaped, preserved, categoriesPreserved, overflow, screenshot,
        pass: escaped && preserved.every(Boolean) && categoriesPreserved && !overflow });
    }
  } finally { await page.goto("about:blank"); }
  return { status: checks.length === 3 && checks.every(check => check.pass) && !errors.length ? "PASS" : "FAIL",
    checks, requests, errors, finalUrl: page.url(), boundary: "Synthetic temporary-store fixture; all family API reads/writes mocked; no media or models." };
}
