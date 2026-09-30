# Family AI Teacher design system

## 2026-09-26 visual direction

The current child and parent surfaces use one original **family room** language:
warm cream `#f6f3ed`, paper `#fffdf9`, forest action `#225b49`, ink
`#20342f`, and a restrained peach child surface. The parent recording guide
uses the same tokens so the first-use experience feels part of the product.

The local VoltAgent `awesome-design-md` library informed two choices:
`design-md/airbnb/DESIGN.md` for human photography, generous spacing, and
friendly hit areas; `design-md/intercom/DESIGN.md` for clear editorial hierarchy
and quiet utility surfaces. These are references, not copied brand assets,
fonts, logos, or colors. Keep the existing Dad/media-first interaction and
48px touch targets. On iPad, the camera toggle remains visible inside the
child picture-in-picture frame. Never replace the real parent portrait with
decorative illustration or fabricated mouth motion.

## Scene and direction

A four-year-old sits at the family laptop in morning daylight, ready to tell Dad about a toy. The surface feels like a calm, familiar room: warm paper, Dad as the large primary view, a smaller child preview, and one easy microphone button. The parent visits the same room through a readable growth journal.

This is a product interface. Restrained color carries function: forest green is the primary action and confirmed learning; apricot identifies the child's space and Dad's messages. No decorative motion, gradients, external fonts, generated portraits, or face overlays.

## Tokens

- Page: `oklch(.968 .011 93)`. Paper: `oklch(.992 .006 95)`.
- Ink: `oklch(.29 .031 164)`. Muted text: `oklch(.48 .025 155)`.
- Action: `oklch(.40 .075 163)`. Action hover: `oklch(.33 .07 163)`.
- Dividers: `oklch(.88 .019 107)`. Secondary green: `oklch(.93 .024 157)`.
- Danger: `oklch(.48 .14 28)`. Warning: `oklch(.60 .12 70)`.
- Typography: local Segoe UI / PingFang SC / Microsoft YaHei / system-ui; no network fonts.
- Child title 27px, section title 21px, voice action 20px, conversation text 18px (17px mobile). Parent title 36px, section title 22px, text 13–16px.
- Children’s controls are at least 48px, with a wide microphone action below the primary view. 3px visible keyboard focus. Reduced motion disables all animation.
- Corners: child stage 26px, video 16px, control 18px; parent sections 17px, form controls 9–10px.

## Child surface

1. Use a FaceTime/WeChat-like stage: Dad's avatar is the centered primary view and the child's camera is a small picture-in-picture view. Clicking the small view swaps primary and secondary without reacquiring either media stream. The explicitly opened drawing board temporarily uses the full viewport.
2. Fit the primary stage, voice action, full-width activity row and the beginning of the shared conversation into the first desktop screen. Never let two large equal video tiles push interaction below the fold.
3. Keep the primary voice action dominant. Place drawing, story and one unified play entry across the full width below the stage; the play entry reveals chess, an interaction game, piano and singing as large second-level choices. The keyboard form lives in a native expandable adult helper.
4. Give images, videos and learning links their own large shared stage. Keep the adult transcript quiet: 13px text, one recent turn by default, at most ten when expanded, one vertical message flow. Keep live STT/TTS in that compact feed; persistence still waits for playback acknowledgement. Media must not be squeezed into transcript bubbles or reused for a different requested topic.
5. The child’s closed-camera state explicitly says voice alone works. Camera preview requires an explicit action. Frame upload is separately intentional.
6. AI identity is stated in the header and footer. Preserve Nathan’s real image and tested avatar decoder. Speaking bars communicate state; they are not a fake lip animation.
7. During listening, the existing bars follow the microphone RMS already sampled by voice activity detection. They show loudness, never recognition confidence or correctness. Silence rests at a stable low height; a new listening segment, released input, or another state clears the previous level. Use transform-only motion, keep the existing speaking animation, and hold listening bars still under reduced motion. Do not add microphone access, polling, storage, or repeated accessibility announcements for this feedback.
8. A requested activity begins with its first instruction or story sentence. Keep the child's name in welcomes, comfort, parent messages, and specific progress celebrations; do not add a separate name-only audio clip before every activity. Teaching questions and playback acknowledgement remain intact.
9. Camera controls use three distinct symbols: a video-camera toggle that shows off/on state, a still-camera shutter, and a short-clip record symbol with visible recording progress. Do not use a play triangle for recording. These controls never change the explicit-capture privacy boundary.
10. Reduce visible copy to the current state and the next action. Remove repeated headings, duplicated privacy captions and simultaneous status sentences; keep detailed privacy and setup explanations in the parent surface or native disclosure.

## Drawing surface

Open a white canvas over the full viewport; use native fullscreen when available and the same overlay when unavailable. Default to pressed mouse dragging or touch drawing. Offer an explicit “移动就画” mouse mode, six colors, three widths, eraser, undo and reversible clear. Keep “返回”, “和爸爸说话” and “暂停观察” visible. Escape exits, keyboard focus stays inside the board and returns to the opening control on close.

Opening the board authorizes observation of this canvas only. Prefer a 1.2-second pause, but continuous strokes must schedule progress observation within 5 seconds when voice work is available. Keep actual request starts at least 5 seconds apart; unchanged or blank canvases do not cause repeated requests. Voice work takes priority. Pause, hide and close cancel observation; session checks reject snapshots encoded after closing, while revision checks discard obsolete displayed feedback. Explicit requests to switch activities or rest take priority over the attached canvas; close only after the reply finishes and its receipt succeeds, retaining the RAM drawing for reopening. Do not store raw drawings or treat generated observation prompts as child speech, learning evidence or parent-message replies. Camera frames remain separately limited to explicit camera requests.

Keep the voice controls usable while drawing and put concise feedback beside the canvas. A photo or text request during continuous conversation pauses the current input segment and resumes listening after playback; it must not silently consume the child's next answer.

## Parent surface

Model and network controls live in an expandable parent-only section. Show the selected service, model and separate search/image providers; never return a saved key to the browser. Testing is explicit and does not save. Saving applies to future requests; switching image providers cancels obsolete jobs. Explain subscription access and separately billed API access here, not in the child's play surface.

Reading order is today, growth journal, learning states, family memory, then expandable settings. Dad’s message is prominent beside today. Technical endpoints and model identifiers do not belong in growth content.

Statistics are a compact text strip, without fabricated growth percentages. Topic contact is labeled as contact, not competence. Confirmed milestones and candidates use different wording. Empty states explain what a real conversation will provide.

Keep the child's recorded questions visible independently of the recent conversation timeline: a quiet list of original words in today's overview and the weekly journal. Reuse the existing dashboard fields; do not label them as a complete archive, infer mastery from curiosity, or add a blank section when no questions are available.

The memory library fetches the complete local collection independently of the dashboard preview. Search and type filters operate over the full collection, with ten visible records per page. Corrections are inline. Mutations show pending/success/failure, preserve typed content on failure, and do not overwrite unsaved profile changes. Destructive data actions remain progressively disclosed and keep their existing confirmation safeguards.

Weekly journals and parent messages begin with four entries. The earlier-record control expands the complete archive without discarding past years or older child responses. Confirmed skill reviews include the parent’s supporting observation. Important journal facts remain accessible even when a week has many events.

Repeated explicit wishes to spend time with Dad or Mom appear first among that week's facts. Keep the count visible and the three most recent dated source quotes in a native expandable section. Present recorded wishes without diagnosing emotions or assuming that a parent has not responded.

## Verification boundaries

Music offers eight increasing phrases and a forgiving five-lane rhythm mode. Missed notes wait at the landing line, wrong presses keep progress, and actual achievements receive specific spoken encouragement. Use public-domain melody data and optional generated theme previews with separate commercial-rights status. A versioned localStorage record stores only the current and completed exercise IDs; refresh resumes practice, and “从头练” clears only this record. It is not a family memory or mastery score.

The image overlay starts its five-second countdown after the image loads. “继续看5秒” visibly restarts that countdown for the same image. Explicit open-ended requests generate in the background; ordinary conversation continues. Video playback pauses speech capture; closing resumes it after outstanding speech requests release ownership.

Visual and interaction QA uses local browsers without real microphone or camera capture. Synthetic fixtures are browser route responses, never saved to the family database. Screenshots are review evidence under `runtime/`. Physical voice quality, camera understanding and real-time lip synchronization require their own end-to-end evidence.
