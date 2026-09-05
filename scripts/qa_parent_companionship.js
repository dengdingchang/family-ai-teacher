async (page) => {
  // Insert a dashboard built from a TemporaryDirectory MemoryStore. Never read
  // family APIs to prepare this fixture or use live parent mutations in QA.
  const dashboard = /* SYNTHETIC_DASHBOARD */ null;
  if (!dashboard) throw new Error("A temporary-data dashboard fixture is required");
  const errors = [], requests = [], layouts = [];
  page.on("pageerror", error => errors.push(error.message));
  const payloads = {
    "/api/parent/dashboard": dashboard,
    "/api/memories": { memories: [] },
    "/api/parent/messages": { messages: [] },
  };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    requests.push({ path, method: request.method() });
    if (request.method() !== "GET" || !payloads[path]) {
      errors.push(`Blocked unexpected request: ${request.method()} ${path}`);
      return route.fulfill({ status: 403, body: "Unexpected API blocked by QA" });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payloads[path]) });
  });
  try {
    for (const size of [{ width: 1400, height: 960 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.goto("http://127.0.0.1:8760/parent");
      await page.waitForFunction(() => document.querySelectorAll(".companionship-note").length === 2);
      const summaries = page.locator(".companionship-note summary");
      await summaries.first().focus();
      await page.keyboard.press("Enter");
      await summaries.nth(1).click();
      const checks = await page.evaluate(() => {
        const notes = [...document.querySelectorAll(".companionship-note")];
        return {
          count: notes.length,
          titles: notes.map(note => note.querySelector("summary").textContent),
          quotes: notes.map(note => [...note.querySelectorAll("ol p")].map(quote => quote.textContent)),
          dates: notes.map(note => [...note.querySelectorAll("time")].map(time => ({ iso: time.dateTime, displayed: time.textContent }))),
          open: notes.every(note => note.querySelector("details").open),
          overflow: [...document.querySelectorAll(".journal-panel,.companionship-note,.companionship-note p")]
            .some(element => element.scrollWidth > element.clientWidth + 1),
          documentOverflow: document.documentElement.scrollWidth > innerWidth,
          text: document.querySelector("#journalContent").textContent,
        };
      });
      await page.locator(".journal-panel").scrollIntoViewIfNeeded();
      const screenshot = `output/playwright/parent-companionship-${size.width}.png`;
      await page.screenshot({ path: screenshot, fullPage: false });
      layouts.push({ ...size, ...checks, screenshot,
        pass: checks.count === 2 && checks.open && !checks.overflow && !checks.documentOverflow
          && checks.titles.some(title => title.includes("想和爸爸一起搭积木"))
          && checks.titles.some(title => title.includes("想和妈妈一起画画"))
          && checks.titles.every(title => title.includes("3 次"))
          && checks.quotes.every(group => group.length === 3)
          && checks.dates.every(group => group.length === 3 && group.every(date => date.iso && date.displayed))
          && !/孤独|被忽视|失落|未被回应/.test(checks.text) });
    }
  } finally {
    await page.goto("about:blank");
    // Keep the API guard until this owned browser context is closed.
  }
  return { status: layouts.length === 2 && layouts.every(layout => layout.pass) && !errors.length ? "PASS" : "FAIL",
    layouts, requests, errors, finalUrl: page.url(), boundary: "Actual temporary-store aggregate, rendered in desktop/mobile browsers with all family APIs intercepted. No media, model, or family writes." };
}
