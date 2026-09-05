async (page) => {
  // Exercise the real browser player and microphone lifecycle with synthetic
  // silence. All data APIs and Avatar sockets are intercepted before loading.
  const requests = [], errors = [], layouts = [], completions = [], routeIntervals = [];
  let browserIntervals = [];
  const wavBase64 = await page.evaluate(() => {
    const bytes=new Uint8Array(44+3840), view=new DataView(bytes.buffer);
    const text=(offset,value)=>bytes.set([...value].map(char=>char.charCodeAt(0)),offset);
    text(0,"RIFF"); view.setUint32(4,bytes.length-8,true); text(8,"WAVEfmt ");
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,16000,true); view.setUint32(28,32000,true);
    view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,"data");
    view.setUint32(40,bytes.length-44,true);
    return btoa(String.fromCharCode(...bytes));
  });
  const onError = error => errors.push(error.message);
  page.on("pageerror", onError);
  if (typeof page.routeWebSocket !== "function") throw new Error("WebSocket isolation is required");
  await page.routeWebSocket("**/ws/avatar", socket => socket.close());
  await page.addInitScript(() => {
    window.__activityVoiceQa = { devices: [], streams: [], contexts: [], playback: [], timing: [], deny: false };
    // Keep synthetic timing inside the page even if a Playwright route fails or
    // releases a pending keepalive during browser teardown. Never restore this
    // guard while its document can still emit a pagehide request.
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const isRequest = input instanceof Request;
      const url = new URL(isRequest ? input.url : String(input), location.href);
      const method = String(init?.method || (isRequest ? input.method : "GET")).toUpperCase();
      if (method !== "POST" || url.pathname !== "/api/conversation/interaction-interval") {
        return originalFetch(input, init);
      }
      let body = {}, validJson = true;
      try {
        body = JSON.parse(init?.body ?? (isRequest ? await input.clone().text() : ""));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid timing body");
      } catch (_) { body = {}; validJson = false; }
      const duration = (Date.parse(body.end_at) - Date.parse(body.start_at)) / 1000;
      window.__activityVoiceQa.timing.push({
        sessionId: typeof body.session_id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.session_id) ? body.session_id : null,
        sequence: Number.isInteger(body.sequence) ? body.sequence : null,
        durationSeconds: Number.isFinite(duration) ? duration : null,
        validJson, keepalive: init?.keepalive ?? (isRequest ? input.keepalive : false), fulfilled: true,
      });
      return new Response(JSON.stringify({ok:true,recorded:true,qa_intercepted:true}), {
        status:200, headers:{"Content-Type":"application/json"},
      });
    };
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = async constraints => {
      const qa = window.__activityVoiceQa;
      qa.devices.push({audio: Boolean(constraints.audio), video: Boolean(constraints.video)});
      if (constraints.video) throw new Error("Physical camera access is forbidden in this QA");
      if (qa.deny) throw new DOMException("Synthetic denial", "NotAllowedError");
      const context = new AudioContext();
      await context.resume();
      const destination = context.createMediaStreamDestination();
      qa.contexts.push(context); qa.streams.push(destination.stream);
      return destination.stream;
    };
    addEventListener("family-audio-playback", event => {
      window.__activityVoiceQa.playback.push({type: event.detail.type, generation: event.detail.generation});
    });
    addEventListener("pagehide", () => {
      for (const stream of window.__activityVoiceQa.streams) stream.getTracks().forEach(track => track.stop());
      for (const context of window.__activityVoiceQa.contexts) void context.close();
    });
  });
  async function intercept(route) {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/api/avatar" || path === "/api/avatar/idle") return route.continue();
    requests.push({path, method: request.method()});
    let payload;
    if (path === "/health") payload = {status:"ok", stt_ready:true, tts_ready:true, tts_warmup:"ready", llm_configured:true, avatar_idle_ready:true, interaction_timing_supported:true};
    else if (path === "/api/profile") payload = {name:"测试探索家", enabled_activities:["drawing","story","game","vision_photo"]};
    else if (path === "/api/memory/history") payload = {history:[],count:0};
    else if (path === "/api/conversation/text/stream") {
      const text = request.postDataJSON().text;
      const events = [
        {event:"user_text", text},
        {event:"assistant_delta", text:"我们画一个圆圆的头，好吗？"},
        {event:"audio", sequence:1, semantic:true, audio_stream:true, audio_base64:wavBase64, audio_mime:"audio/wav", avatar:false},
        {event:"done", ok:true, assistant_text:"我们画一个圆圆的头，好吗？", commit_required:true},
      ];
      return route.fulfill({status:200,contentType:"text/event-stream",body:events.map(event=>`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`).join("")});
    } else if (/\/complete$/.test(path)) {
      const ended = await page.evaluate(() => window.__activityVoiceQa.playback.filter(item => item.type === "ended").length);
      completions.push({endedSources:ended}); payload={ok:true,history:null};
    } else if (path === "/api/conversation/interaction-interval") {
      // Second layer; normally the page guard handles this before networking.
      let body = {}, validJson = true;
      try { body = request.postDataJSON() || {}; } catch (_) { validJson = false; }
      const duration = (Date.parse(body.end_at) - Date.parse(body.start_at)) / 1000;
      routeIntervals.push({method:request.method(),validJson,sequence:Number.isInteger(body.sequence)?body.sequence:null,durationSeconds:Number.isFinite(duration)?duration:null});
      payload={ok:true,recorded:true,qa_intercepted:true};
    } else if (/\/cancel$/.test(path)) payload={ok:true,recorded:true};
    else throw new Error(`Unexpected data API: ${request.method()} ${path}`);
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(payload)});
  }
  await page.route(/\/api\/|\/health(?:\?|$)/, intercept);
  let flow;
  try {
    await page.emulateMedia({reducedMotion:"reduce"});
    for (const size of [{width:1366,height:768},{width:1280,height:720},{width:390,height:844}]) {
      await page.setViewportSize(size);
      await page.goto("http://127.0.0.1:8760/");
      await page.waitForFunction(() => document.querySelector("#serviceBadge")?.textContent === "准备好了");
      const layout = await page.evaluate(() => {
        const button=document.querySelector("#recordButton").getBoundingClientRect();
        const tiles=[...document.querySelectorAll(".video-tile")].map(tile=>tile.getBoundingClientRect().width);
        return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,primaryButton:{top:button.top,bottom:button.bottom,height:button.height},tileWidths:tiles};
      });
      const screenshot=`output/playwright/activity-entry-${size.width}x${size.height}.png`;
      await page.screenshot({path:screenshot,fullPage:false});
      layouts.push({...layout,screenshot});
    }
    await page.setViewportSize({width:1366,height:768});
    await page.goto("http://127.0.0.1:8760/");
    await page.locator('[data-activity="drawing"]').click();
    await page.waitForFunction(() => document.querySelector("#recordHint").textContent.startsWith("我会一直听") && window.__activityVoiceQa.playback.some(item=>item.type==="ended"));
    const first = await page.evaluate(() => ({active:document.querySelector("#recordButton").getAttribute("aria-pressed"),requests:window.__activityVoiceQa.devices.length}));
    await page.locator('[data-activity="story"]').click();
    await page.waitForFunction(() => document.querySelector("#recordHint").textContent.startsWith("我会一直听") && window.__activityVoiceQa.playback.filter(item=>item.type==="ended").length === 2);
    const reused = await page.evaluate(() => ({active:document.querySelector("#recordButton").getAttribute("aria-pressed"),requests:window.__activityVoiceQa.devices.length}));
    await page.locator("#recordButton").click();
    const stopped = await page.evaluate(() => ({active:document.querySelector("#recordButton").getAttribute("aria-pressed"),tracksEnded:window.__activityVoiceQa.streams.every(stream=>stream.getTracks().every(track=>track.readyState==="ended"))}));
    await page.evaluate(() => { window.__activityVoiceQa.deny=true; });
    await page.locator('[data-activity="drawing"]').click();
    await page.waitForFunction(() => document.querySelector("#recordHint").textContent.includes("请家长帮忙打开麦克风"));
    const denied = await page.evaluate(() => ({active:document.querySelector("#recordButton").getAttribute("aria-pressed"),hint:document.querySelector("#recordHint").textContent,devices:window.__activityVoiceQa.devices}));
    const streamRequests=requests.filter(request=>request.path==="/api/conversation/text/stream").length;
    flow={first,reused,stopped,denied,streamRequests,completions};
    flow.pass=first.active==="true" && reused.active==="true" && first.requests===1 && reused.requests===1 && stopped.active==="false" && stopped.tracksEnded && denied.active==="false" && denied.devices.every(item=>item.audio&&!item.video) && streamRequests===2 && completions.length===2 && completions.every((item,index)=>item.endedSources===index+1);
  } finally {
    // End the synthetic session and flush its final interval while both guards
    // are present. The browser guard stays installed through pagehide.
    try {
      browserIntervals = await page.evaluate(async () => {
        if (typeof stopContinuousConversation === "function") stopContinuousConversation();
        globalThis.familyInteractionClock?.end();
        const qa = window.__activityVoiceQa;
        for (const stream of qa?.streams || []) stream.getTracks().forEach(track => track.stop());
        await Promise.all((qa?.contexts || []).map(context => context.close().catch(() => {})));
        return qa?.timing || [];
      });
    } catch (error) { errors.push(`Synthetic teardown: ${error.message}`); }
    await page.goto("about:blank");
    // Retain the route guard for the owned QA context, including late requests.
    page.off("pageerror",onError);
  }
  return {status:flow?.pass && errors.length===0 ? "PASS":"FAIL",flow,layouts,errors,interactionTimingQa:{browserInterceptedCount:browserIntervals.length,browserIntervals,routeInterceptedCount:routeIntervals.length,routeIntervals},finalUrl:page.url(),boundary:"Browser fetch and network guards isolate synthetic timing; mock data APIs and Avatar sockets; real WebAudio with synthetic silence. Family-file hashes require separate verification. Layout is reported separately."};
}
