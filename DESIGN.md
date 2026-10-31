# A2B interface baseline

This records the current upstream visual system and the acceptance target for incremental fixes.
It does not introduce a new framework, brand or comprehensive redesign. Reference: UI UX Pro Max,
applied selectively to existing HTML/CSS/ES modules. Map remains the primary content.

| Semantic token | Day | Night |
|---|---|---|
| Surface / secondary / raised | `#ffffff` / `#f3f5f8` / `#e7ebf0` | `#161b22` / `#1f2630` / `#2a333f` |
| Main / secondary text | `#11181c` / `#5f6b76` | `#edf1f5` / `#9aa6b2` |
| Divider | `#dde2e8` | `#313b47` |
| Primary / secondary plum | `#751b4f` / `#a8306d` | `#a8306d` / `#c4498a` |
| Accent text | `#751b4f` | `#ec9ac4` |

Use the existing `styles.css` custom properties, not copied literal colours in components.
Report orange, danger red and success green need text/icon context; colour alone is insufficient.
Contrast of every composed surface/state still needs measured audit; this document is not a WCAG pass.

- Typography: system sans, current body 16px/1.35, 16px editable fields, tabular numbers for journey
  metrics. Long names wrap where useful; vital instructions must remain readable at 200% text zoom.
- Spacing: retain current 12/14/18px component rhythm and 18px radius; consolidate locally when
  editing, rather than rewriting all styles. Account forms use grid gaps and a readable maximum width.
- Targets: existing round controls 52px, small 44px, form inputs 50px. Aim for approximately 44×44
  CSS px on primary touch controls; WCAG AA target minimum is 24px with exceptions, not universal 44px.
- Surfaces: map with contextual sheets; one primary action for current state. Account/settings are
  scrollable screens. Keep controls clear of safe-area insets, software keyboard and sheet edges.
- Focus: visible 3px accent outline on new account controls; labels and appropriate autocomplete;
  focus first field on entry and triggering control on cancel/success. Error uses text, role=alert and
  a focusable summary for server failures. Do not trap focus/inert background for a non-modal screen.
- Loading: decorative spinner separated from text; action disabled and aria-busy while saving;
  validation does not submit; server failure leaves retry available. Empty/error/partial states must be
  distinct. Never report copied/saved/complete until the relevant operation confirms it.
- Motion: use only to orient the user and respect reduced motion. Global matchMedia override on
  main remains an open defect (M5-B); do not claim existing app-wide compliance.
- Day/night: use actual `:root[data-theme='night']` theme selector (verify against CSS in each visual test).
  Screenshots and browser checks use synthetic content; no account secrets or personal locations.

Review matrix: 320, 360/390, 430, 768 and 1280 CSS px; include 375 and landscape; day/night,
long names, 200% text zoom, keyboard navigation and a resized viewport approximating keyboard space.
Browser emulation is not physical-device, OS keyboard, Dynamic Type, VoiceOver or on-road evidence.
