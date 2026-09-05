async (page) => {
  // Block timing writes at the network boundary, including teardown keepalive.
  const interactionRoute = /\/api\/conversation\/interaction-interval(?:\?.*)?$/;
  const interactionIntervals = [];
  async function interceptInteractionInterval(route) {
    const request = route.request();
    let body = {};
    let validJson = true;
    try {
      body = request.postDataJSON() || {};
    } catch (_) {
      validJson = false;
    }
    const elapsed = (Date.parse(body.end_at) - Date.parse(body.start_at)) / 1000;
    const record = {
      method: request.method(),
      resourceType: request.resourceType(),
      validJson,
      hasSessionId: typeof body.session_id === "string",
      sequence: Number.isInteger(body.sequence) ? body.sequence : null,
      durationSeconds: Number.isFinite(elapsed) ? elapsed : null,
      fulfilled: false,
    };
    interactionIntervals.push(record);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, recorded: true, qa_intercepted: true }),
    });
    record.fulfilled = true;
  }
  await page.route(interactionRoute, interceptInteractionInterval);
  // Real software services with synthetic microphone media only. Never retain media payloads.
  let failure = "",
    result;
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(async () => {
      await window.__restoreSyntheticVoiceQa?.();
      const qa = (window.__syntheticVoiceQa = {
        started: performance.now(),
        inputs: [],
        turns: [],
        playback: [],
        errors: [],
        devices: [],
        audioNodes: [],
        views: [],
        idleAdvanceCount: 0,
        signalThreshold: 0.001,
        nonZeroThreshold: 1 / 32768,
        inputRmsSamples: [],
        inputLevels: {},
        bargeGateSamples: [],
        avatarTransport: [],
        avatarDecode: [],
        environment: {
          hidden: document.hidden,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        },
      });
      const at = () => performance.now() - qa.started;
      const originalFetch = window.fetch.bind(window);
      const originalDevices = navigator.mediaDevices.getUserMedia;
      const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
      const originalSocketSend = WebSocket.prototype.send;
      const originalDecode = window.VideoDecoder?.prototype.decode;
      const bargeGatePrototype = window.BargeInGate?.prototype;
      const originalBargeGateUpdate = bargeGatePrototype?.update;
      const socketListeners = new Map();
      WebSocket.prototype.send = function (data) {
        if (new URL(this.url).pathname === "/ws/avatar") {
          if (!socketListeners.has(this)) {
            const listener = (event) =>
              qa.avatarTransport.push({
                at: at(),
                turn: qa.turns.length - 1,
                direction: "received",
                binary: typeof event.data !== "string",
                size:
                  event.data.size ?? event.data.byteLength ?? event.data.length,
              });
            socketListeners.set(this, listener);
            this.addEventListener("message", listener);
          }
          let type = "binary";
          if (typeof data === "string") {
            try {
              type = JSON.parse(data).type;
            } catch (_) {
              type = "unknown";
            }
          }
          qa.avatarTransport.push({
            at: at(),
            turn: qa.turns.length - 1,
            direction: "sent",
            type,
          });
        }
        return originalSocketSend.call(this, data);
      };
      if (originalDecode)
        VideoDecoder.prototype.decode = function (chunk) {
          const event = {
            at: at(),
            turn: qa.turns.length - 1,
            type: chunk.type,
            timestamp: chunk.timestamp,
            size: chunk.byteLength,
          };
          qa.avatarDecode.push(event);
          try {
            return originalDecode.call(this, chunk);
          } catch (error) {
            event.error = error.name;
            throw error;
          }
        };
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const inputSources = new Set();
      const sourceMethods = [
        ...new Set(
          [
            window.AudioContext?.prototype,
            window.webkitAudioContext?.prototype,
          ].filter(Boolean),
        ),
      ].map((prototype) => [prototype, prototype.createBufferSource]);
      const analyserMethods = sourceMethods.map(([prototype]) => [
        prototype,
        prototype.createAnalyser,
      ]);
      const inputMeters = [];
      let nextInputSample = 0,
        inputLoudSince = null,
        lastInputIndex = -1;
      let sampler,
        previousView = "",
        previousIdleTime = null;
      const view = () => {
        const idle = document.querySelector("#avatarIdle");
        return {
          state: document.querySelector("#avatarStage")?.dataset.state,
          canvasVisible: !document.querySelector("#avatarCanvas")?.hidden,
          idleVisible: Boolean(idle && !idle.hidden),
          idlePaused: idle?.paused,
          idleMuted: idle?.muted,
          idleTime: idle?.currentTime,
        };
      };
      qa.snapshotView = view;
      qa.historySnapshot = async () => {
        const history = await (
          await originalFetch("/api/memory/history")
        ).json();
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(history)),
        );
        return {
          count: history.count,
          sha256: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        };
      };
      const onPlayback = (event) => {
        const detail = event.detail || {};
        qa.playback.push({ ...detail, at: at() });
        let turn = qa.turns.find(
          (item) => item.generation === detail.generation,
        );
        if (!turn && detail.type === "scheduled") {
          turn = qa.turns.at(-1);
          if (turn) turn.generation = detail.generation;
        }
        const node = qa.audioNodes.find((item) =>
          detail.type === "scheduled"
            ? item.generation === null &&
              Math.abs(item.contextStart - detail.contextStartTime) < 0.000001
            : item.generation === detail.generation &&
              item.sequence === detail.segment,
        );
        if (node && detail.type === "scheduled") {
          node.generation = detail.generation;
          node.sequence = detail.segment;
        }
        // This telemetry comes from the player's real onended callback. A second
        // native listener can observe that same event after the receipt starts.
        if (node && detail.type === "ended" && node.endedAt === null)
          node.endedAt = at();
      };
      // Register cleanup before the first awaited network/fixture operation.
      window.__restoreSyntheticVoiceQa = async () => {
        clearInterval(sampler);
        for (const source of inputSources) {
          try {
            source.stop();
          } catch (_) {}
        }
        for (const node of qa.audioNodes) {
          try {
            node.source.stop();
          } catch (_) {}
          try {
            node.analyser.disconnect();
            node.muted.disconnect();
          } catch (_) {}
        }
        destination.stream.getTracks().forEach((track) => track.stop());
        if (context.state !== "closed") await context.close();
        window.fetch = originalFetch;
        navigator.mediaDevices.getUserMedia = originalDevices;
        CanvasRenderingContext2D.prototype.drawImage = originalDraw;
        WebSocket.prototype.send = originalSocketSend;
        for (const [socket, listener] of socketListeners)
          socket.removeEventListener("message", listener);
        if (originalDecode) VideoDecoder.prototype.decode = originalDecode;
        if (originalBargeGateUpdate)
          bargeGatePrototype.update = originalBargeGateUpdate;
        for (const [prototype, original] of sourceMethods)
          prototype.createBufferSource = original;
        for (const [prototype, original] of analyserMethods)
          prototype.createAnalyser = original;
        window.removeEventListener("family-audio-playback", onPlayback);
        window.__speakSyntheticInput = null;
        window.__restoreSyntheticVoiceQa = null;
      };
      if (originalBargeGateUpdate)
        bargeGatePrototype.update = function (level, now) {
          // Observe the actual gate after its original decision; do not replay it.
          const triggered = originalBargeGateUpdate.call(this, level, now);
          qa.bargeGateConfig ||= {
            threshold: this.threshold,
            requiredVoicedMs: this.voicedMs,
            sampleMs: this.sampleMs,
            maxGapMs: this.maxGapMs,
            windowMs: this.windowMs,
          };
          qa.bargeGateSamples.push({
            at: now - qa.started,
            level,
            triggered,
            turn: qa.turns.length - 1,
            voicedMs: this.voiced.reduce(
              (total, sample) => total + Math.min(
                sample.duration,
                sample.end - (now - this.windowMs),
              ),
              0,
            ),
          });
          return triggered;
        };
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        qa.devices.push({
          audio: Boolean(constraints.audio),
          video: Boolean(constraints.video),
        });
        if (constraints.video || !constraints.audio)
          throw new Error("Only synthetic audio is permitted");
        return destination.stream;
      };
      for (const [prototype, original] of analyserMethods)
        prototype.createAnalyser = function (...args) {
          const meter = original.apply(this, args);
          if (this !== context) inputMeters.push(meter);
          return meter;
        };
      for (const [prototype, original] of sourceMethods) {
        prototype.createBufferSource = function (...args) {
          const source = original.apply(this, args);
          if (this === context) return source; // Fixture input is not answer output.
          const audioContext = this,
            originalStart = source.start;
          source.start = function (when = 0, ...rest) {
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0;
            const muted = audioContext.createGain();
            muted.gain.value = 0;
            source.connect(analyser);
            analyser.connect(muted);
            muted.connect(audioContext.destination);
            const node = {
              source,
              context: audioContext,
              analyser,
              muted,
              samples: new Float32Array(256),
              generation: null,
              sequence: null,
              contextStart: Math.max(when, audioContext.currentTime),
              duration: source.buffer?.duration || 0,
              scheduledAt: at(),
              firstSignalAt: null,
              firstNonZeroAt: null,
              lastSignalAt: null,
              latestPeak: 0,
              peak: 0,
              endedAt: null,
            };
            qa.audioNodes.push(node);
            source.addEventListener(
              "ended",
              () => {
                node.endedAt ??= at();
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
      window.addEventListener("family-audio-playback", onPlayback);
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas?.id === "avatarCanvas") {
          const turn = qa.turns.at(-1);
          if (turn) {
            turn.drawCount = (turn.drawCount || 0) + 1;
            turn.firstDrawAt ??= at();
          }
        }
        return originalDraw.apply(this, args);
      };
      sampler = setInterval(() => {
        const inputMeter = inputMeters.find((meter) => meter.fftSize === 1024);
        if (inputMeter) {
          const sampleTime = at(),
            inputIndex = qa.inputs.at(-1)?.index ?? -1;
          const samples = new Uint8Array(inputMeter.fftSize);
          inputMeter.getByteTimeDomainData(samples);
          let squares = 0;
          for (const value of samples) squares += ((value - 128) / 128) ** 2;
          const rms = Math.sqrt(squares / samples.length);
          if (inputIndex !== lastInputIndex) {
            inputLoudSince = null;
            lastInputIndex = inputIndex;
          }
          const levels = (qa.inputLevels[inputIndex] ||= {
            peakRms: 0,
            maxContinuousAbove075Ms: 0,
            threshold: 0.075,
          });
          levels.peakRms = Math.max(levels.peakRms, rms);
          if (rms >= 0.075) {
            inputLoudSince ??= sampleTime;
            levels.maxContinuousAbove075Ms = Math.max(
              levels.maxContinuousAbove075Ms,
              sampleTime - inputLoudSince,
            );
          } else inputLoudSince = null;
          if (sampleTime >= nextInputSample) {
            qa.inputRmsSamples.push({ at: sampleTime, inputIndex, rms });
            nextInputSample = sampleTime + 40;
          }
        }
        for (const node of qa.audioNodes) {
          if (node.endedAt !== null) {
            node.latestPeak = 0;
            continue;
          }
          node.analyser.getFloatTimeDomainData(node.samples);
          let peak = 0;
          for (const sample of node.samples)
            peak = Math.max(peak, Math.abs(sample));
          node.latestPeak = peak;
          node.peak = Math.max(peak, node.peak);
          if (peak >= qa.nonZeroThreshold) node.firstNonZeroAt ??= at();
          if (peak >= qa.signalThreshold) {
            node.firstSignalAt ??= at();
            node.lastSignalAt = at();
          }
        }
        const snapshot = view(),
          signature = JSON.stringify({ ...snapshot, idleTime: undefined });
        if (signature !== previousView) {
          qa.views.push({ at: at(), turn: qa.turns.length - 1, ...snapshot });
          previousView = signature;
        }
        if (
          snapshot.idleVisible &&
          !snapshot.idlePaused &&
          snapshot.idleTime !== previousIdleTime
        )
          qa.idleAdvanceCount++;
        previousIdleTime = snapshot.idleTime;
      }, 5);
      window.fetch = async (input, init = {}) => {
        const path = new URL(
          typeof input === "string" ? input : input.url,
          location.href,
        ).pathname;
        const completion = /\/api\/conversation\/turns\/[^/]+\/complete$/.test(
          path,
        );
        const cancellation = /\/api\/conversation\/turns\/[^/]+\/cancel$/.test(
          path,
        );
        if (completion || cancellation) {
          const turn = qa.turns.find(
            (item) => item.id === path.split("/").at(-2),
          );
          if (completion) {
            if (turn) {
              turn.completeRequestedAt = at();
              const nodes = qa.audioNodes.filter(
                (node) => node.generation === turn.generation,
              );
              turn.nodesAtComplete = nodes.length;
              turn.endedAtComplete = nodes.filter(
                (node) => node.endedAt !== null,
              ).length;
              turn.doneAtComplete = turn.events.some(
                (event) => event.event === "done" && event.ok === true,
              );
            }
            const response = await originalFetch(
              path.replace("/complete", "/cancel"),
              { method: "POST" },
            );
            const receipt = await response.json();
            if (turn) {
              turn.cancelReceipt = receipt;
              turn.cancelReceiptAt = at();
            }
            if (!response.ok || receipt.cancelled !== true)
              throw new Error("QA completion cancellation failed");
            if (turn) turn.playbackCompleteAt = at();
            return new Response(
              JSON.stringify({ ok: true, history: null, qa_cancelled: true }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (turn) turn.interruptedAt ??= at();
          const response = await originalFetch(input, init);
          if (turn) {
            turn.interruptReceipt = await response.clone().json();
            turn.interruptReceiptAt = at();
          }
          return response;
        }
        if (path === "/api/conversation/stream") {
          const turn = {
            id: new Headers(init.headers).get("X-Conversation-Turn-Id"),
            streaming:
              new Headers(init.headers).get("X-Audio-Streaming") === "1",
            requestAt: at(),
            events: [],
          };
          qa.turns.push(turn);
          init.signal?.addEventListener(
            "abort",
            () => {
              turn.abortedAt = at();
            },
            { once: true },
          );
          const response = await originalFetch(input, init);
          turn.status = response.status;
          if (response.ok && response.body)
            void (async () => {
              const reader = response.clone().body.getReader(),
                decoder = new TextDecoder();
              let pending = "";
              const record = (frame) => {
                const data = frame
                  .replaceAll("\r", "")
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .join("\n");
                if (!data) return;
                const event = JSON.parse(data);
                turn.events.push({
                  event: event.event,
                  at: at(),
                  sequence: event.sequence,
                  semantic: event.semantic,
                  audioStream: event.audio_stream,
                  ttsStartedS: Number.isFinite(event.tts_started_s) ? event.tts_started_s : undefined,
                  ttsCallS: Number.isFinite(event.tts_call_s) ? event.tts_call_s : undefined,
                  deltaChars: event.event === "assistant_delta" && typeof event.text === "string"
                    ? event.text.length : undefined,
                  avatar: Boolean(
                    event.avatar_cued ||
                    event.avatar_pending ||
                    event.avatar_pcm_base64,
                  ),
                  text: event.event === "user_text" ? event.text : undefined,
                  assistant:
                    event.event === "done" ? event.assistant_text : undefined,
                  ok: event.ok,
                  sttSeconds: event.stt_elapsed_s,
                });
              };
              try {
                while (true) {
                  const { value, done } = await reader.read();
                  pending += decoder.decode(value || new Uint8Array(), {
                    stream: !done,
                  });
                  const frames = pending.split("\n\n");
                  pending = frames.pop() || "";
                  for (const frame of frames) record(frame);
                  if (done) {
                    if (pending.trim()) record(pending);
                    break;
                  }
                }
                turn.readerDone = true;
              } catch (error) {
                turn.readError = error.name;
              } finally {
                reader.releaseLock();
              }
            })();
          return response;
        }
        return originalFetch(input, init);
      };
      qa.historyBefore = await qa.historySnapshot();
      const words = [
          "我想画一只恐龙。",
          "为什么树叶在秋天会变黄？",
          "我想听一个恐龙故事。",
        ],
        buffers = [];
      for (const text of words) {
        const response = await originalFetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok)
          throw new Error("Synthetic voice fixture generation failed");
        const payload = await response.json();
        const bytes = Uint8Array.from(atob(payload.audio_base64), (character) =>
          character.charCodeAt(0),
        );
        buffers.push(await context.decodeAudioData(bytes.buffer));
      }
      window.__speakSyntheticInput = async (index) => {
        if (context.state !== "running") await context.resume();
        const old = qa.turns[1];
        const activeNode = qa.audioNodes.find(
          (node) =>
            node.generation === old?.generation &&
            node.endedAt === null &&
            node.latestPeak >= qa.signalThreshold &&
            node.context.currentTime >= node.contextStart &&
            node.context.currentTime < node.contextStart + node.duration,
        );
        if (index === 2 && !activeNode)
          throw new Error(
            "Interruption requires a rendering old-generation signal",
          );
        if (index === 2)
          qa.bargeEvidence = {
            at: at(),
            generation: old.generation,
            sequence: activeNode.sequence,
            peak: activeNode.latestPeak,
            contextTime: activeNode.context.currentTime,
            plannedEnd: activeNode.contextStart + activeNode.duration,
            sampleAt: activeNode.lastSignalAt,
            ended: false,
          };
        const source = context.createBufferSource(),
          gain = context.createGain();
        gain.gain.value = 1.6;
        source.buffer = buffers[index];
        source.connect(gain).connect(destination);
        qa.inputs.push({
          index,
          text: words[index],
          duration: source.buffer.duration,
          at: at(),
        });
        inputSources.add(source);
        source.onended = () => {
          inputSources.delete(source);
          source.disconnect();
          gain.disconnect();
        };
        source.start(context.currentTime);
      };
    });
    await page.locator("#recordButton").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#recordButton").getAttribute("aria-pressed") ===
          "true" &&
        document.querySelector("#avatarStage").dataset.state === "listening",
      null,
      { timeout: 12000 },
    );
    await page.evaluate(() => window.__speakSyntheticInput(0));
    await page.waitForFunction(
      () => Boolean(window.__syntheticVoiceQa.turns[0]?.playbackCompleteAt),
      null,
      { timeout: 45000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#avatarStage").dataset.state === "listening",
      null,
      { timeout: 10000 },
    );
    await page.evaluate(() => {
      const qa = window.__syntheticVoiceQa;
      qa.firstReturnedToListening = {
        at: performance.now() - qa.started,
        ...qa.snapshotView(),
      };
    });
    await page.evaluate(() => window.__speakSyntheticInput(1));
    await page.waitForFunction(
      () => {
        const qa = window.__syntheticVoiceQa,
          turn = qa.turns[1];
        if (!turn || qa.inputs.some((input) => input.index === 2))
          return Boolean(qa.bargeEvidence);
        const sounding = qa.audioNodes.some(
          (node) =>
            node.generation === turn.generation &&
            node.endedAt === null &&
            node.latestPeak >= qa.signalThreshold &&
            node.context.currentTime >= node.contextStart &&
            node.context.currentTime < node.contextStart + node.duration,
        );
        if (!sounding) return false;
        void window
          .__speakSyntheticInput(2)
          .catch((error) => qa.errors.push(error.message));
        return Boolean(qa.bargeEvidence);
      },
      null,
      { timeout: 45000 },
    );
    await page.waitForFunction(
      () => Boolean(window.__syntheticVoiceQa.turns[1]?.abortedAt),
      null,
      { timeout: 12000 },
    );
    await page.waitForFunction(
      () => Boolean(window.__syntheticVoiceQa.turns[2]?.playbackCompleteAt),
      null,
      { timeout: 45000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#avatarStage").dataset.state === "listening",
      null,
      { timeout: 10000 },
    );
    await page.evaluate(() => {
      const qa = window.__syntheticVoiceQa;
      qa.thirdReturnedToListening = {
        at: performance.now() - qa.started,
        ...qa.snapshotView(),
      };
    });
  } catch (error) {
    failure = String(error?.message || error);
  } finally {
    try {
      if (
        (await page.locator("#recordButton").getAttribute("aria-pressed")) ===
        "true"
      )
        await page.locator("#recordButton").click();
      result = await page.evaluate(async (failure) => {
        const qa = window.__syntheticVoiceQa;
        if (!qa) return { status: "FAIL", failure };
        for (const turn of qa.turns) {
          if (
            !turn.cancelReceipt?.cancelled &&
            !turn.interruptReceipt?.cancelled
          ) {
            try {
              turn.cleanupReceipt = await (
                await fetch(
                  `/api/conversation/turns/${encodeURIComponent(turn.id)}/cancel`,
                  { method: "POST" },
                )
              ).json();
            } catch (error) {
              qa.errors.push(`Cleanup cancel: ${error.name}`);
            }
          }
        }
        const historyAfter = await qa.historySnapshot();
        const words = qa.turns.map(
          (turn) =>
            turn.events.find((event) => event.event === "user_text")?.text ||
            "",
        );
        const normal = (index) => {
          const turn = qa.turns[index];
          return Boolean(
            turn?.streaming &&
            turn.readerDone &&
            !turn.readError &&
            turn.playbackCompleteAt &&
            turn.cancelReceipt?.cancelled &&
            turn.doneAtComplete &&
            turn.nodesAtComplete > 0 &&
            turn.nodesAtComplete === turn.endedAtComplete &&
            turn.nodesAtComplete ===
              turn.events.filter((event) => event.event === "audio").length,
          );
        };
        const old = qa.turns[1];
        const cancelled =
          old &&
          qa.playback.find(
            (event) =>
              event.generation === old.generation &&
              event.type === "cancelled" &&
              event.at >= old.abortedAt,
          );
        const oldScheduledAfterCancel = cancelled
          ? qa.playback.filter(
              (event) =>
                event.generation === old.generation &&
                event.type === "scheduled" &&
                event.at > cancelled.at,
            )
          : [];
        const checks = {
          firstComplete: normal(0),
          thirdComplete: normal(2),
          firstContinued: qa.firstReturnedToListening?.state === "listening",
          thirdRecovered: qa.thirdReturnedToListening?.state === "listening",
          recognizedThreeInputs:
            /[画畫]/.test(words[0] || "") &&
            /恐龙|恐龍/.test(words[0] || "") &&
            /树叶|樹葉/.test(words[1] || "") &&
            /秋|黄|黃/.test(words[1] || "") &&
            /故事/.test(words[2] || "") &&
            /恐龙|恐龍/.test(words[2] || ""),
          actualSignalAtInterruption: Boolean(
            qa.bargeEvidence &&
            !qa.bargeEvidence.ended &&
            qa.bargeEvidence.peak >= qa.signalThreshold,
          ),
          oldTurnInterrupted: Boolean(
            old?.abortedAt &&
            old.interruptReceipt?.cancelled &&
            !old.completeRequestedAt &&
            cancelled &&
            !oldScheduledAfterCancel.length,
          ),
          noHistoryWrite:
            historyAfter.count === qa.historyBefore?.count &&
            historyAfter.sha256 === qa.historyBefore?.sha256,
          syntheticDevicesOnly:
            qa.devices.length > 0 &&
            qa.devices.every((device) => device.audio && !device.video),
          exactlyThreeTurns: qa.turns.length === 3,
        };
        const idleReturn = (snapshot) =>
          snapshot?.idleVisible &&
          !snapshot.idlePaused &&
          snapshot.idleMuted &&
          !snapshot.canvasVisible;
        const visualChecks = {
          firstSpeakingCanvas: Boolean(qa.turns[0]?.drawCount),
          thirdSpeakingCanvas: Boolean(qa.turns[2]?.drawCount),
          firstIdleReturn: Boolean(idleReturn(qa.firstReturnedToListening)),
          thirdIdleReturn: Boolean(idleReturn(qa.thirdReturnedToListening)),
          idleActuallyAdvanced: qa.idleAdvanceCount > 0,
          noOverlappingLayers: !qa.views.some(
            (view) => view.canvasVisible && view.idleVisible,
          ),
          canvasPausesIdle: !qa.views.some(
            (view) => view.canvasVisible && !view.idlePaused,
          ),
        };
        const functionalPass =
          !failure && !qa.errors.length && Object.values(checks).every(Boolean);
        const mechanicalFlowPass =
          !failure &&
          !qa.errors.length &&
          Object.entries(checks)
            .filter(([name]) => name !== "recognizedThreeInputs")
            .every(([, passed]) => passed);
        const visualPass = Object.values(visualChecks).every(Boolean);
        const min = (values) => {
          const numbers = values.filter(Number.isFinite);
          return numbers.length ? Math.min(...numbers) : null;
        };
        const difference = (left, right) =>
          Number.isFinite(left) && Number.isFinite(right)
            ? Math.round((left - right) * 10) / 10
            : null;
        const turnTiming = qa.turns.map((turn, index) => {
          const nodes = qa.audioNodes.filter(
            (node) => node.generation === turn.generation,
          );
          const audio = turn.events.filter((event) => event.event === "audio");
          const semantic = nodes.filter(
            (node) =>
              audio.find((event) => event.sequence === node.sequence)
                ?.semantic === true,
          );
          const avatar = nodes.filter(
            (node) =>
              audio.find((event) => event.sequence === node.sequence)?.avatar,
          );
          const firstNonZeroAt = min(nodes.map((node) => node.firstNonZeroAt));
          const firstSignalAt = min(nodes.map((node) => node.firstSignalAt));
          const semanticNonZeroAt = min(
            semantic.map((node) => node.firstNonZeroAt),
          );
          const semanticSignalAt = min(
            semantic.map((node) => node.firstSignalAt),
          );
          const avatarNonZeroAt = min(
            avatar.map((node) => node.firstNonZeroAt),
          );
          return {
            index,
            generation: turn.generation,
            requestAt: turn.requestAt,
            firstNonZeroLatencyMs: difference(firstNonZeroAt, turn.requestAt),
            firstSignalLatencyMs: difference(firstSignalAt, turn.requestAt),
            semanticFirstNonZeroLatencyMs: difference(
              semanticNonZeroAt,
              turn.requestAt,
            ),
            semanticFirstSignalLatencyMs: difference(
              semanticSignalAt,
              turn.requestAt,
            ),
            firstDrawLatencyMs: difference(turn.firstDrawAt, turn.requestAt),
            avatarFirstDrawMinusAudioNonZeroMs: difference(
              turn.firstDrawAt,
              avatarNonZeroAt,
            ),
            nonsemanticSegments: audio
              .filter((event) => event.semantic !== true)
              .map((event) => event.sequence),
            drawCount: turn.drawCount || 0,
          };
        });
        return {
          status:
            functionalPass && visualPass
              ? "PASS"
              : functionalPass
                ? "PARTIAL"
                : "FAIL",
          functionalPass,
          mechanicalFlowPass,
          visualPass,
          turnTiming,
          measurement: {
            signalPeak: qa.signalThreshold,
            nonzeroPeak: qa.nonZeroThreshold,
            sampleIntervalMs: 5,
            latencyOrigin:
              "conversation audio-stream request after VAD, including STT",
            semanticRule:
              "only SSE semantic=true audio; nickname and acknowledgements are excluded",
            physicalSpeaker: "NOT RUN",
          },
          checks,
          visualChecks,
          failure,
          boundary:
            "Synthetic media and real software services. AnalyserNode proves browser rendering only; physical microphone, speaker echo and camera NOT RUN.",
          historyBefore: qa.historyBefore,
          historyAfter,
          errors: qa.errors,
          devices: qa.devices,
          inputs: qa.inputs,
          turns: qa.turns,
          playback: qa.playback,
          bargeEvidence: qa.bargeEvidence,
          bargeGateConfig: qa.bargeGateConfig || null,
          bargeGateSamples: qa.bargeGateSamples,
          firstReturnedToListening: qa.firstReturnedToListening,
          thirdReturnedToListening: qa.thirdReturnedToListening,
          views: qa.views,
          idleAdvanceCount: qa.idleAdvanceCount,
          environment: qa.environment,
          inputLevels: qa.inputLevels,
          inputRmsSamples: qa.inputRmsSamples,
          avatarTransport: qa.avatarTransport,
          avatarDecode: qa.avatarDecode,
          audioNodes: qa.audioNodes.map((node) => ({
            generation: node.generation,
            sequence: node.sequence,
            contextStart: node.contextStart,
            duration: node.duration,
            scheduledAt: node.scheduledAt,
            firstSignalAt: node.firstSignalAt,
            firstNonZeroAt: node.firstNonZeroAt,
            lastSignalAt: node.lastSignalAt,
            endedAt: node.endedAt,
            peak: node.peak,
          })),
        };
      }, failure);
      await page.screenshot({
        path: "output/playwright/synthetic-voice-journey.png",
        fullPage: true,
      });
    } catch (error) {
      result = {
        status: "FAIL",
        failure,
        cleanupError: String(error?.message || error),
      };
    } finally {
      await page
        .evaluate(async () => {
          await window.__restoreSyntheticVoiceQa?.();
        })
        .catch(() => {});
      await page.goto("about:blank");
      await page.unroute(interactionRoute, interceptInteractionInterval);
    }
  }
  return {
    ...result,
    interactionTimingQa: {
      interceptedCount: interactionIntervals.length,
      requests: interactionIntervals,
      scope: "Simulated timing success through page teardown; family learning_events hash is checked externally.",
    },
  };
}
