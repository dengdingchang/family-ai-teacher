async (page) => {
  // Filled only from TemporaryDirectory MemoryStore aggregates. All family API
  // reads and unexpected mutations are intercepted before opening the parent UI.
  const fixtures = /* SYNTHETIC_QUESTION_FIXTURES */ null;
  if (!fixtures) throw new Error("Temporary question fixtures are required");
  const errors = [], requests = [], layouts = [];
  const run = new Date().toISOString().replace(/[:.]/g, "-");
  let dashboard = fixtures.populated;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    requests.push({ path, method: request.method() });
    const payloads = {
      "/api/parent/dashboard": dashboard,
      "/api/memories": { memories: [] },
      "/api/parent/messages": { messages: [] },
    };
    if (request.method() !== "GET" || !payloads[path]) {
      errors.push(`Blocked unexpected API: ${request.method()} ${path}`);
      return route.fulfill({ status: 403, body: "Unexpected API blocked by QA" });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payloads[path]) });
  });
  try {
    for (const size of [{ width: 1400, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 760 }]) {
      for (const name of ["populated", "empty", "question_only"]) {
        dashboard = fixtures[name];
        await page.setViewportSize(size);
        await page.goto("http://127.0.0.1:8760/parent");
        await page.waitForFunction(count => document.querySelector("#todayTurns")?.textContent === `${count}轮完整对话`,
          dashboard.today.conversation_turns);
        const expected = { today: dashboard.today.questions,
          journal: dashboard.growth_journal.flatMap(entry => entry.questions || []) };
        await page.waitForFunction(values => document.querySelectorAll("#todayQuestions .question-quotes li").length === values.today.length
          && document.querySelectorAll(".journal-questions .question-quotes li").length === values.journal.length, expected);
        const checks = await page.evaluate(values => {
          const today = document.querySelector("#todayQuestions");
          const journal = document.querySelector("#journalContent");
          const visible = element => Boolean(element && element.getClientRects().length
            && getComputedStyle(element).visibility !== "hidden");
          const todayTexts = [...document.querySelectorAll("#todayQuestions .question-quotes li")].map(li => li.textContent);
          const journalTexts = [...document.querySelectorAll(".journal-questions .question-quotes li")].map(li => li.textContent);
          const quoteRoots = [...document.querySelectorAll("#todayQuestions,.journal-questions")];
          return {
            todayTexts, journalTexts,
            todayMatches: JSON.stringify(todayTexts) === JSON.stringify(values.today.map(value => `“${value.trim()}”`)),
            journalMatches: JSON.stringify(journalTexts) === JSON.stringify(values.journal.map(value => `“${value.trim()}”`)),
            todayVisibilityCorrect: visible(today) === Boolean(values.today.length),
            emptyJournalHidden: values.journal.length > 0 || document.querySelectorAll(".journal-questions").length === 0,
            noInjectedHtml: !window.__qaQuestionInjected && quoteRoots.every(root => !root.querySelector("img,script,iframe")),
            noQuestionOnlyEmptyMessage: !values.journal.length || !journal.textContent.includes("这一周还没有形成足够的成长证据"),
            documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            quoteOverflow: [...document.querySelectorAll("#todayQuestions,.journal-questions,.question-quotes li")]
              .some(element => visible(element) && element.scrollWidth > element.clientWidth + 1),
          };
        }, expected);
        const screenshots = [];
        if (name === "populated") {
          for (const [target, label] of [[".today-panel", "today"], [".journal-panel", "journal"]]) {
            await page.locator(target).scrollIntoViewIfNeeded();
            const screenshot = `output/playwright/parent-questions-${size.width}-${label}-${run}.png`;
            await page.screenshot({ path: screenshot, fullPage: false });
            screenshots.push(screenshot);
          }
        }
        layouts.push({ name, ...size, ...checks, screenshots,
          pass: checks.todayMatches && checks.journalMatches && checks.todayVisibilityCorrect
            && checks.emptyJournalHidden && checks.noInjectedHtml && checks.noQuestionOnlyEmptyMessage
            && !checks.documentOverflow && !checks.quoteOverflow });
      }
    }
  } finally {
    await page.goto("about:blank");
    // Retain the API guard until this owned browser context is closed.
  }
  return { status: layouts.length === 9 && layouts.every(item => item.pass) && !errors.length ? "PASS" : "FAIL",
    layouts, requests, errors, finalUrl: page.url(), fixtureEvidence: fixtures.evidence,
    boundary: "Actual temporary-store question aggregates plus an explicitly reduced question-only journal fixture. All family APIs mocked; no media/model/family writes. UI displays only the supplied subsets, not an inferred complete archive." };
}
