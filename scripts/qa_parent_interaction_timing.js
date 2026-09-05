async (page) => {
  // Entirely synthetic parent data; no API request reaches family storage.
  const requests = [];
  const errors = [];
  const layouts = [];
  let today;
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  const mockApi = async (route) => {
    const request = route.request();
    const path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    requests.push({ path, method: request.method() });
    const payloads = {
      "/api/parent/dashboard": {
        today,
        profile: { age: 4 },
        skill_graph: { skills: [] },
        growth_journal: [],
        memory_tiers: {},
      },
      "/api/memories": { memories: [] },
      "/api/parent/messages": { messages: [] },
    };
    await route.fulfill({
      status: request.method() === "GET" && payloads[path] ? 200 : 403,
      contentType: "application/json",
      body: JSON.stringify(payloads[path] || { detail: "Unexpected API blocked by QA" }),
    });
  };
  await page.route("**/api/**", mockApi);
  try {
    for (const sample of [
      { label: "desktop", width: 1400, height: 960, seconds: 2820, available: true, turns: 3, expected: "47分0秒" },
      { label: "mobile", width: 390, height: 844, seconds: 0, available: false, turns: 79, expected: "尚无计时" },
    ]) {
      today = {
        conversation_turns: sample.turns,
        interaction_seconds: sample.seconds,
        interaction_timing_available: sample.available,
        topics: [],
        recent_turns: [],
      };
      await page.setViewportSize({ width: sample.width, height: sample.height });
      await page.goto("http://127.0.0.1:8760/parent");
      await page.waitForFunction((expected) =>
        document.getElementById("todayInteractionTime")?.textContent === expected,
      sample.expected);
      await page.locator("#messageSaveStatus").waitFor({ state: "attached" });
      const layout = await page.evaluate(() => {
        const rect = (element) => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        const cards = [...document.querySelectorAll(".overview-grid .metric-card")];
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
          time: document.getElementById("todayInteractionTime").textContent,
          turns: document.getElementById("todayTurns").textContent,
          note: document.getElementById("interactionTimingNote").textContent.trim(),
          dashboardStatus: document.getElementById("dashboardStatus").textContent,
          cards: cards.map((element) => ({ ...rect(element), text: element.innerText })),
          overflow: [...document.querySelectorAll(".overview-grid *, #interactionTimingNote")]
            .filter((element) => element.getClientRects().length &&
              (element.scrollWidth > element.clientWidth + 1 ||
                element.getBoundingClientRect().right > innerWidth + 1))
            .map((element) => element.id || element.className || element.tagName),
        };
      });
      const screenshot = `output/playwright/parent-interaction-timing-${sample.label}.png`;
      await page.screenshot({ path: screenshot, fullPage: false });
      layouts.push({
        sample: sample.label,
        pass: layout.documentWidth === sample.width && layout.overflow.length === 0 &&
          layout.time === sample.expected && layout.turns === `${sample.turns}轮完整对话` &&
          layout.cards.length === 3 && !layout.dashboardStatus,
        screenshot,
        ...layout,
      });
    }
  } finally {
    await page.goto("about:blank");
    await page.unroute("**/api/**", mockApi);
    page.off("pageerror", onError);
  }
  return {
    status: layouts.length === 2 && layouts.every((layout) => layout.pass) && errors.length === 0 ? "PASS" : "FAIL",
    boundary: "All parent APIs are mocked; no model calls or family data reads/writes.",
    layouts,
    interceptedRequests: requests,
    errors,
    finalUrl: page.url(),
  };
}
