# Family AI Teacher design system

## Scene and direction

A four-year-old sits at the family laptop in morning daylight, ready to tell Dad about a toy. The surface feels like a calm, familiar room: warm paper, two equal places to meet, one easy microphone button. The parent visits the same room through a readable growth journal.

This is a product interface. Restrained color carries function: forest green is the primary action and confirmed learning; apricot identifies the child's space and Dad's messages. No decorative motion, gradients, external fonts, generated portraits, or face overlays.

## Tokens

- Page: `oklch(.968 .011 93)`. Paper: `oklch(.992 .006 95)`.
- Ink: `oklch(.29 .031 164)`. Muted text: `oklch(.48 .025 155)`.
- Action: `oklch(.40 .075 163)`. Action hover: `oklch(.33 .07 163)`.
- Dividers: `oklch(.88 .019 107)`. Secondary green: `oklch(.93 .024 157)`.
- Danger: `oklch(.48 .14 28)`. Warning: `oklch(.60 .12 70)`.
- Typography: local Segoe UI / PingFang SC / Microsoft YaHei / system-ui; no network fonts.
- Child title 27px, section title 21px, voice action 20px, conversation text 15px. Parent title 36px, section title 22px, text 13–16px. Mobile uses fixed smaller steps.
- Children’s main controls are at least 48px, the microphone 66–68px. 3px visible keyboard focus. Reduced motion disables all animation.
- Corners: child stage 26px, video 16px, control 18px; parent sections 17px, form controls 9–10px.

## Child surface

1. Always preserve equal-width teacher and child viewports, including narrow screens.
2. Fit the voice action into the first desktop screen. Size portraits around available height; never make a giant photo push the primary action below the fold.
3. Voice action first, three distinct illustrated activity choices second. The keyboard form lives in a native expandable adult helper.
4. Complete history remains available in a bounded scrollable log with keyboard access. Real-time text remains separate until playback is acknowledged.
5. The child’s closed-camera state explicitly says voice alone works. Camera preview requires an explicit action. Frame upload is separately intentional.
6. AI identity is stated in the header and footer. Preserve Nathan’s real image and tested avatar decoder. Speaking bars communicate state; they are not a fake lip animation.

## Parent surface

Reading order is today, growth journal, learning states, family memory, then expandable settings. Dad’s message is prominent beside today. Technical endpoints and model identifiers do not belong in growth content.

Statistics are a compact text strip, without fabricated growth percentages. Topic contact is labeled as contact, not competence. Confirmed milestones and candidates use different wording. Empty states explain what a real conversation will provide.

The memory library fetches the complete local collection independently of the dashboard preview. Search and type filters operate over the full collection, with ten visible records per page. Corrections are inline. Mutations show pending/success/failure, preserve typed content on failure, and do not overwrite unsaved profile changes. Destructive data actions remain progressively disclosed and keep their existing confirmation safeguards.

Weekly journals and parent messages begin with four entries. The earlier-record control expands the complete archive without discarding past years or older child responses. Confirmed skill reviews include the parent’s supporting observation. Important journal facts remain accessible even when a week has many events.

## Verification boundaries

Visual and interaction QA uses local browsers without real microphone or camera capture. Synthetic fixtures are browser route responses, never saved to the family database. Screenshots are review evidence under `runtime/`. Physical voice quality, camera understanding and real-time lip synchronization require their own end-to-end evidence.
