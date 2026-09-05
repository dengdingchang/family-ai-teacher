async (page) => {
  // Measures the browser audio renderer, never the physical loudspeaker.
  // Generated speech samples live only in AnalyserNode memory and are discarded.
  const historyBefore = await page.evaluate(
    async () => (await (await fetch("/api/memory/history")).json()).count,
  );
  await page.evaluate(() => {
    window.__avatarQaRestore?.();
    const qa = (window.__avatarQa = {
      startedAt: performance.now(),
      streamEvents: [],
      playbackEvents: [],
      audioNodes: [],
      legacyPlays: [],
      legacyEnds: [],
      cueRequests: [],
      websocketEvents: [],
      decoderEvents: [],
      drawCount: 0,
      canvasVisibleSamples: 0,
      silenceRuns: [],
      currentSilence: null,
      signalThreshold: 0.001,
      nonZeroThreshold: 1 / 32768,
    });
    const now = () => performance.now() - qa.startedAt;
    const originalFetch = window.fetch.bind(window);
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    const originalWebSocketSend = WebSocket.prototype.send;
    const decoderPrototype = window.VideoDecoder?.prototype;
    const originalDecode = decoderPrototype?.decode;
    const originalDecoderReset = decoderPrototype?.reset;
    const observedSockets = new Map();
    // Attach on first send so an already-open Avatar socket is observable.
    // Retain only timing, counts, codec metadata and sizes, never media payloads.
    WebSocket.prototype.send = function (data) {
      if (new URL(this.url).pathname === "/ws/avatar") {
        if (!observedSockets.has(this)) {
          const onMessage = (event) => {
            const binary = typeof event.data !== "string";
            qa.websocketEvents.push({
              direction: "received",
              atMs: now(),
              binary,
              size: binary
                ? (event.data.size ?? event.data.byteLength ?? null)
                : event.data.length,
            });
          };
          observedSockets.set(this, onMessage);
          this.addEventListener("message", onMessage);
        }
        let type = "binary";
        if (typeof data === "string") {
          try {
            type = JSON.parse(data).type || "unknown";
          } catch (_) {
            type = "unknown";
          }
        }
        qa.websocketEvents.push({ direction: "sent", atMs: now(), type });
      }
      return originalWebSocketSend.call(this, data);
    };
    if (originalDecode)
      decoderPrototype.decode = function (chunk) {
        const event = {
          operation: "decode",
          atMs: now(),
          type: chunk.type,
          timestamp: chunk.timestamp,
          bytes: chunk.byteLength,
          state: this.state,
        };
        qa.decoderEvents.push(event);
        try {
          return originalDecode.call(this, chunk);
        } catch (error) {
          event.error = error?.name || "decode error";
          throw error;
        }
      };
    if (originalDecoderReset)
      decoderPrototype.reset = function () {
        qa.decoderEvents.push({
          operation: "reset",
          atMs: now(),
          state: this.state,
        });
        return originalDecoderReset.call(this);
      };
    const prototypes = [
      ...new Set(
        [
          window.AudioContext?.prototype,
          window.webkitAudioContext?.prototype,
        ].filter(Boolean),
      ),
    ];
    const sourceMethods = prototypes.map((prototype) => [
      prototype,
      prototype.createBufferSource,
    ]);
    const onPlayback = (event) => {
      const detail = event.detail || {};
      qa.playbackEvents.push({ ...detail, atMs: now() });
      if (detail.type === "scheduled") {
        const node = qa.audioNodes.find(
          (item) =>
            item.segment === null &&
            Math.abs(item.contextStartTime - detail.contextStartTime) <
              0.000001,
        );
        if (node) node.segment = detail.segment;
      } else if (detail.type === "ended") {
        // The player's actual onended callback can run before another native
        // listener on the same event. Record that event before receipt fetch.
        const node = qa.audioNodes.find(
          (item) => item.segment === detail.segment,
        );
        if (node && node.endedMs === null) node.endedMs = now();
      }
    };
    window.addEventListener("family-audio-playback", onPlayback);
    for (const [prototype, original] of sourceMethods) {
      prototype.createBufferSource = function (...args) {
        const source = original.apply(this, args);
        const context = this;
        const originalStart = source.start;
        source.start = function (when = 0, ...rest) {
          const analyser = context.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0;
          const muted = context.createGain();
          muted.gain.value = 0;
          // A silent observation branch keeps the graph processed without
          // adding another audible copy or changing the original output path.
          source.connect(analyser);
          analyser.connect(muted);
          muted.connect(context.destination);
          const record = {
            source,
            context,
            analyser,
            muted,
            samples: new Float32Array(256),
            segment: null,
            contextStartTime: Math.max(when, context.currentTime),
            duration: source.buffer?.duration || 0,
            scheduledAtMs: now(),
            firstNonZeroMs: null,
            firstSignalMs: null,
            lastSignalMs: null,
            endedMs: null,
            peak: 0,
            observations: 0,
          };
          qa.audioNodes.push(record);
          source.addEventListener(
            "ended",
            () => {
              if (record.endedMs === null) record.endedMs = now();
              analyser.disconnect();
              muted.disconnect();
            },
            { once: true },
          );
          return originalStart.call(source, when, ...rest);
        };
        return source;
      };
    }
    qa.sampler = setInterval(() => {
      const at = now();
      let signal = false;
      let coverage = false;
      for (const node of qa.audioNodes) {
        if (node.endedMs !== null) continue;
        const clock = node.context.currentTime;
        if (
          clock >= node.contextStartTime &&
          clock < node.contextStartTime + node.duration
        )
          coverage = true;
        node.analyser.getFloatTimeDomainData(node.samples);
        let peak = 0;
        for (const sample of node.samples)
          peak = Math.max(peak, Math.abs(sample));
        node.observations += 1;
        node.peak = Math.max(node.peak, peak);
        if (peak >= qa.nonZeroThreshold && node.firstNonZeroMs === null)
          node.firstNonZeroMs = at;
        if (peak >= qa.signalThreshold) {
          signal = true;
          if (node.firstSignalMs === null) node.firstSignalMs = at;
          node.lastSignalMs = at;
          if (qa.firstOutputSignalMs === undefined) qa.firstOutputSignalMs = at;
        }
      }
      if (
        qa.firstOutputSignalMs !== undefined &&
        qa.audioNodes.some((node) => node.endedMs === null)
      ) {
        const kind = coverage
          ? "within-scheduled-audio"
          : "without-scheduled-audio";
        if (qa.currentSilence && (signal || qa.currentSilence.kind !== kind)) {
          qa.silenceRuns.push({
            ...qa.currentSilence,
            endMs: at,
            durationMs: at - qa.currentSilence.startMs,
          });
          qa.currentSilence = null;
        }
        if (!signal && !qa.currentSilence)
          qa.currentSilence = { kind, startMs: at };
      }
      const canvas = document.querySelector("#avatarCanvas");
      if (qa.streamRequestedAt !== undefined && canvas && !canvas.hidden) {
        qa.canvasVisibleSamples += 1;
        if (qa.firstCanvasVisibleAt === undefined) qa.firstCanvasVisibleAt = at;
      }
    }, 5);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/conversation/text/stream")) {
        const headers = new Headers(init.headers || {});
        qa.turnId = headers.get("X-Conversation-Turn-Id");
        qa.streamingRequested = headers.get("X-Audio-Streaming") === "1";
        qa.streamRequestedAt = now();
      }
      if (/\/avatar\/\d+$/.test(url)) qa.cueRequests.push(now());
      if (/\/api\/conversation\/turns\/[^/]+\/complete$/.test(url)) {
        qa.completeAt = now();
        qa.nodesEndedAtComplete = qa.audioNodes.filter(
          (node) => node.endedMs !== null,
        ).length;
        qa.sourcesScheduledAtComplete = qa.audioNodes.length;
        const response = await originalFetch(
          url.replace("/complete", "/cancel"),
          { method: "POST" },
        );
        qa.cancelResult = await response.json();
        return new Response(
          JSON.stringify({ ok: true, history: null, qa_cancelled: true }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      const response = await originalFetch(input, init);
      if (
        url.includes("/api/conversation/text/stream") &&
        response.ok &&
        response.body
      ) {
        void (async () => {
          const reader = response.clone().body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const record = (frame) => {
            const data = frame
              .replaceAll("\r", "")
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data) return;
            const event = JSON.parse(data);
            qa.streamEvents.push({
              event: event.event,
              atMs: now(),
              semantic: event.semantic,
              audioStream: event.audio_stream,
              avatar: Boolean(
                event.avatar_cued ||
                event.avatar_pending ||
                event.avatar_pcm_base64,
              ),
              sequence: event.sequence,
              backend: event.tts_backend,
              ttsStartedS: event.tts_started_s,
              ttsCallS: event.tts_call_s,
              serverS: event.tts_server_elapsed_s,
              durationS: event.audio_duration_s,
              ok: event.ok,
              audioCount: event.audio_count,
            });
          };
          try {
            while (true) {
              const { value, done } = await reader.read();
              buffer += decoder.decode(value || new Uint8Array(), {
                stream: !done,
              });
              const frames = buffer.split("\n\n");
              buffer = frames.pop() || "";
              for (const frame of frames) record(frame);
              if (done) break;
            }
            if (buffer.trim()) record(buffer);
          } catch (error) {
            qa.streamReadError = error?.name || "stream read failed";
          } finally {
            reader.releaseLock();
          }
        })();
      }
      return response;
    };
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.tagName === "AUDIO") {
        qa.legacyPlays.push(now());
        this.addEventListener("ended", () => qa.legacyEnds.push(now()), {
          once: true,
        });
      }
      return originalPlay.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (
        qa.streamRequestedAt !== undefined &&
        this.canvas?.id === "avatarCanvas"
      ) {
        qa.drawCount += 1;
        if (qa.firstDrawAt === undefined) qa.firstDrawAt = now();
      }
      return originalDrawImage.apply(this, args);
    };
    window.__avatarQaRestore = () => {
      window.fetch = originalFetch;
      HTMLMediaElement.prototype.play = originalPlay;
      CanvasRenderingContext2D.prototype.drawImage = originalDrawImage;
      WebSocket.prototype.send = originalWebSocketSend;
      for (const [socket, listener] of observedSockets)
        socket.removeEventListener("message", listener);
      if (originalDecode) decoderPrototype.decode = originalDecode;
      if (originalDecoderReset) decoderPrototype.reset = originalDecoderReset;
      for (const [prototype, original] of sourceMethods)
        prototype.createBufferSource = original;
      window.removeEventListener("family-audio-playback", onPlayback);
      clearInterval(qa.sampler);
      for (const node of qa.audioNodes) {
        try {
          node.analyser.disconnect();
          node.muted.disconnect();
        } catch (_) {}
      }
      window.__avatarQaRestore = null;
    };
  });

  let browserError = "";
  try {
    await page.locator(".grownup-help").evaluate((element) => {
      element.open = true;
    });
    const text = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("qaText") ||
        "为什么树叶在秋天会变黄？",
    );
    await page.locator("#textInput").fill(text);
    await page.locator('#textForm button[type="submit"]').click();
    await page.waitForFunction(
      () => Boolean(window.__avatarQa?.cancelResult),
      null,
      { timeout: 45000 },
    );
  } catch (error) {
    browserError = String(error?.message || error);
    await page.evaluate(async () => {
      const qa = window.__avatarQa;
      if (qa?.turnId && !qa.cancelResult?.cancelled) {
        qa.cancelResult = await (
          await fetch(
            `/api/conversation/turns/${encodeURIComponent(qa.turnId)}/cancel`,
            { method: "POST" },
          )
        ).json();
      }
      for (const node of qa?.audioNodes || []) {
        if (node.endedMs === null) {
          try {
            node.source.stop();
          } catch (_) {}
        }
      }
    });
  }
  const result = await page.evaluate(
    async ({ historyBefore, browserError }) => {
      const qa = window.__avatarQa;
      const historyAfter = (await (await fetch("/api/memory/history")).json())
        .count;
      const round = (value) =>
        Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
      const audioEvents = qa.streamEvents.filter(
        (event) => event.event === "audio",
      );
      const nodes = qa.audioNodes.map((node) => {
        const event = audioEvents.find(
          (event) => event.sequence === node.segment,
        );
        return {
          sequence: node.segment,
          semantic: event?.semantic === true,
          plannedContextStartS: node.contextStartTime,
          durationS: node.duration,
          scheduledAtMs: round(node.scheduledAtMs),
          firstNonZeroMs: round(node.firstNonZeroMs),
          firstSignalMs: round(node.firstSignalMs),
          lastSignalMs: round(node.lastSignalMs),
          endedMs: round(node.endedMs),
          peak: node.peak,
          observations: node.observations,
        };
      });
      const minOrNull = (values) =>
        values.length ? Math.min(...values) : null;
      const firstNonZeroMs = minOrNull(
        nodes.map((node) => node.firstNonZeroMs).filter(Number.isFinite),
      );
      const semanticFirstSignalMs = minOrNull(
        nodes
          .filter((node) => node.semantic)
          .map((node) => node.firstSignalMs)
          .filter(Number.isFinite),
      );
      const semanticFirstNonZeroMs = minOrNull(
        nodes
          .filter((node) => node.semantic)
          .map((node) => node.firstNonZeroMs)
          .filter(Number.isFinite),
      );
      const semanticLatencyMs = Number.isFinite(semanticFirstSignalMs)
        ? semanticFirstSignalMs - qa.streamRequestedAt
        : null;
      const scheduledGapsMs = nodes
        .slice(1)
        .map((node, index) =>
          round(
            (node.plannedContextStartS -
              nodes[index].plannedContextStartS -
              nodes[index].durationS) *
              1000,
          ),
        );
      const maxScheduledGapMs = Math.max(0, ...scheduledGapsMs);
      const done = qa.streamEvents.find((event) => event.event === "done");
      const firstAvatarNonZeroMs = minOrNull(
        nodes
          .filter(
            (node) =>
              audioEvents.find((event) => event.sequence === node.sequence)
                ?.avatar,
          )
          .map((node) => node.firstNonZeroMs)
          .filter(Number.isFinite),
      );
      const avatarOffsetMs =
        Number.isFinite(qa.firstDrawAt) && Number.isFinite(firstAvatarNonZeroMs)
          ? qa.firstDrawAt - firstAvatarNonZeroMs
          : null;
      const functionalPass =
        !browserError &&
        !qa.streamReadError &&
        done?.ok === true &&
        qa.streamingRequested &&
        nodes.length > 0 &&
        nodes.length === audioEvents.length &&
        qa.nodesEndedAtComplete === nodes.length &&
        qa.cancelResult?.cancelled === true &&
        qa.completeAt >= done.atMs &&
        historyBefore === historyAfter;
      const voiceExperiencePass =
        Number.isFinite(semanticLatencyMs) &&
        semanticLatencyMs <= 2500 &&
        maxScheduledGapMs <= 80;
      const avatarExperiencePass =
        qa.drawCount >= 2 &&
        Number.isFinite(avatarOffsetMs) &&
        Math.abs(avatarOffsetMs) <= 180;
      return {
        status:
          functionalPass && voiceExperiencePass && avatarExperiencePass
            ? "PASS"
            : functionalPass
              ? "PARTIAL"
              : "FAIL",
        functionalPass,
        voiceExperiencePass,
        avatarExperiencePass,
        evidenceBoundary:
          "AnalyserNode samples prove browser-rendered audio; physical speaker/microphone echo is NOT tested. Scheduling timestamps are reported separately.",
        thresholds: {
          semanticRenderedSignalMs: 2500,
          maxScheduledGapMs: 80,
          avatarOffsetMs: 180,
          signalPeak: qa.signalThreshold,
          sampleIntervalMs: 5,
        },
        historyBefore,
        historyAfter,
        browserError,
        turnId: qa.turnId,
        streamingRequested: qa.streamingRequested,
        streamRequestedMs: round(qa.streamRequestedAt),
        firstNonZeroMs: round(firstNonZeroMs),
        semanticFirstNonZeroMs: round(semanticFirstNonZeroMs),
        semanticFirstSignalMs: round(semanticFirstSignalMs),
        semanticLatencyMs: round(semanticLatencyMs),
        scheduledGapsMs,
        maxScheduledGapMs,
        audioNodes: nodes,
        playbackEvents: qa.playbackEvents,
        streamEvents: qa.streamEvents,
        websocketEvents: qa.websocketEvents,
        decoderEvents: qa.decoderEvents,
        silenceRuns: qa.silenceRuns.map((run) => ({
          kind: run.kind,
          startMs: round(run.startMs),
          endMs: round(run.endMs),
          durationMs: round(run.durationMs),
        })),
        legacyPlayCount: qa.legacyPlays.length,
        legacyPlaysMs: qa.legacyPlays.map(round),
        legacyEndsMs: qa.legacyEnds.map(round),
        legacyMeasurement: qa.legacyPlays.length
          ? "play() calls only, no rendered-onset proof"
          : "not used",
        streamReadError: qa.streamReadError || "",
        firstDrawMs: round(qa.firstDrawAt),
        drawCount: qa.drawCount,
        avatarOffsetMs: round(avatarOffsetMs),
        firstAvatarNonZeroMs: round(firstAvatarNonZeroMs),
        firstCanvasVisibleMs: round(qa.firstCanvasVisibleAt),
        canvasVisibleSamples: qa.canvasVisibleSamples,
        completeMs: round(qa.completeAt),
        nodesEndedAtComplete: qa.nodesEndedAtComplete,
        cancelled: qa.cancelResult?.cancelled === true,
        avatarState: document.querySelector("#avatarStateText").textContent,
        interfaceStatus: document.querySelector("#statusText").textContent,
        answer: document.querySelector("#answerBox").textContent.trim(),
      };
    },
    { historyBefore, browserError },
  );

  await page.screenshot({
    path: "output/playwright/avatar-streaming.png",
    fullPage: true,
  });
  if (browserError)
    await page.reload(); // Destroy a timed-out turn before removing the receipt interception.
  else await page.evaluate(() => window.__avatarQaRestore?.());
  return result;
}
