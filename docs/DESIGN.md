# Project Last Stand — 3D Battle Royale Survival Game

> An original multiplayer survival shooter inspired by the *battle royale genre* (e.g., PUBG and Free Fire), designed for Android, iOS, and Windows. Build original characters, maps, branding, UI, and assets; do not copy proprietary game content.

## 1. Vision

**Project Last Stand** is a third-person 3D survival shooter in which players deploy into a large map, scavenge for equipment, fight opponents, and survive a shrinking danger zone. The final surviving player or team wins.

**Design pillars:** responsive shooting; readable mobile controls; fair competition; reliable networking; scalable performance; distinct South India-inspired environments.

## 2. Target Platforms and Technology

| Area | Proposed technology |
| --- | --- |
| Engine | Unreal Engine 5 (choose a stable version supported by plugins and target SDKs) |
| Gameplay | C++ for core systems; Blueprints for iteration and UI integration |
| Multiplayer | Unreal replication, dedicated authoritative servers |
| Backend | Auth, lobby, matchmaking, inventory, and telemetry services (provider to be selected) |
| 3D art | Blender; original or properly licensed assets |
| Source control | Git + Git LFS for large binary assets |
| CI/CD | Automated build, test, packaging, and deployment pipelines |
| Platforms | Windows first; Android next; iOS after device and signing validation |

> A full 100-player cross-platform game is a substantial production effort. Begin with a small multiplayer vertical slice before attempting large matches.

## 3. Core Game Loop

1. Sign in and enter the lobby.
2. Select Solo, Duo, or Squad and join matchmaking.
3. Deploy into the map via a transport vehicle or spawn phase.
4. Search buildings and terrain for weapons, ammo, armor, and healing items.
5. Engage enemies, revive teammates where allowed, and move toward the safe zone.
6. Survive successive zone contractions.
7. Win by being the final surviving player or team; review match results.

## 4. Game Modes

| Mode | Team size | Initial prototype target |
| --- | ---: | --- |
| Solo | 1 | 2–8 players in a small arena |
| Duo | 2 | Later milestone |
| Squad | 4 | Later milestone |
| Training | 1 | Offline target practice |
| Custom Room | Configurable | Later milestone |

**Long-term target:** 50–100 players per match, only after load tests prove server, bandwidth, and device performance.

## 5. Gameplay Systems

### Player movement and camera
- Third-person camera, adjustable sensitivity, aim-down-sights, crouch, prone, jump, sprint, vault, and swim (later milestone).
- Mobile virtual joystick, fire/aim buttons, configurable HUD; keyboard/mouse and controller on PC.
- Character animation state machine, footstep audio, directional damage feedback.

### Combat
- Weapon classes: assault rifles, SMGs, sniper rifles, shotguns, pistols, and melee.
- Server-validated firing, reload, ammunition, damage, armor, and elimination.
- Recoil, spread, bullet travel or hitscan as appropriate, and weapon attachments.
- Throwables: grenades and smoke; healing items and teammate revival.
- Weapon balance data stored in editable data assets or tables.

### Loot and inventory
- Ground loot and containers with configurable spawn tables.
- Backpack capacity, equipment slots, item stacking, pickup/drop actions.
- Authoritative inventory transactions to prevent duplication.

### Safe zone
- Match-configured zone center, radius, timing, and damage outside the zone.
- Server owns zone state; clients display synchronized circle and countdown.
- Zones must be tested for reachable terrain and fair placement.

### Vehicles and traversal (later)
- Drivable vehicles with network-aware movement and collision.
- Enter/exit, fuel or health (optional), passenger seating.

### Character progression (later)
- Original character skins and cosmetic unlocks.
- Optional abilities only if they preserve competitive balance.
- No pay-to-win stat advantages.

## 6. Map Direction

Create an **original fictional map inspired by South India** with varied terrain and architecture:

- Dense coastal city and industrial harbor
- Hill station, forests, and rocky cliffs
- Rural villages and farmland
- Highways, bridges, and military-style compounds

Start with a **small greybox arena**. Expand only after movement, shooting, replication, and performance are validated. Use world partition/streaming as appropriate and optimize draw calls, materials, foliage, LODs, and collision.

## 7. Multiplayer Architecture

```text
[Windows / Android / iOS Clients]
              |
        Auth + Matchmaking
              |
       Session / Lobby Service
              |
    [Dedicated Unreal Server]
       |        |        |
   Movement   Combat   Match State
       |        |        |
   Inventory  Loot     Safe Zone
              |
    Results / Telemetry Backend
```

**Authority model:** the dedicated server is the source of truth for health, ammunition, hits, inventory, zone state, and victory. Clients submit inputs and render predicted/interpolated state. Implement relevancy, replication frequency tuning, lag compensation where justified, and rate limits.

**Security:** validate RPC inputs, reject impossible movement/fire rates, protect credentials and service keys, use TLS for backend APIs, enforce server-side permissions, and monitor suspicious match activity. Anti-cheat is layered and requires ongoing operations; no design can guarantee zero cheating.

## 8. Suggested Unreal Project Structure

```text
ProjectLastStand/
├── Config/
├── Content/
│   ├── Characters/
│   ├── Weapons/
│   ├── Maps/
│   ├── UI/
│   ├── Audio/
│   ├── Animations/
│   ├── Items/
│   ├── Vehicles/
│   └── Data/
├── Source/
│   └── ProjectLastStand/
│       ├── Characters/
│       ├── Combat/
│       ├── Inventory/
│       ├── Interaction/
│       ├── GameModes/
│       ├── Networking/
│       └── Zone/
├── Tests/
├── Docs/
├── Scripts/
├── .gitignore
├── .gitattributes
└── README.md
```

## 9. First Playable Vertical Slice (MVP)

**Definition of done:** two or more players can join a dedicated-server match, move, aim, shoot, take damage, pick up one weapon and healing item, survive a shrinking circle, and reach a clear victory/defeat screen.

- [ ] Create UE5 third-person C++ project and source-control repository.
- [ ] Build one small greybox map with collision and cover.
- [ ] Implement replicated player movement and camera.
- [ ] Implement one rifle with server-authoritative damage and ammo.
- [ ] Implement health, elimination, respawn for testing, and spectator view.
- [ ] Add simple loot pickup and inventory.
- [ ] Add shrinking safe zone and outside-zone damage.
- [ ] Run a dedicated server and connect at least two clients.
- [ ] Add match start/end logic and winner display.
- [ ] Profile performance and run automated smoke tests.

## 10. Development Roadmap

| Phase | Scope | Exit criterion |
| --- | --- | --- |
| 0 — Preproduction | Design, licensing, architecture, device targets | Approved prototype scope |
| 1 — Core prototype | Character, camera, greybox, weapon | Fun offline combat loop |
| 2 — Network slice | Dedicated server, 2–8 players, replicated combat | Repeatable multiplayer matches |
| 3 — Battle royale MVP | Loot, inventory, circle, match end | Full small-scale match |
| 4 — Mobile optimization | Touch UI, device profiling, graphics tiers | Stable performance on selected test devices |
| 5 — Content expansion | Larger map, more weapons, squads, vehicles | Playtested and balanced content |
| 6 — Scale and operations | Matchmaking, telemetry, load tests, moderation | Measured capacity and reliability |
| 7 — Release readiness | QA, privacy, store policies, accessibility | Store-ready builds and launch checklist |

Dates and staffing estimates should be set after the first prototype, not assumed upfront.

## 11. Performance Targets

Initial engineering goals, **not guaranteed results**:

- PC: target 60 FPS on an explicitly defined reference configuration.
- Mobile: aim for stable 30 FPS on selected midrange devices; investigate 60 FPS on higher-end devices.
- Test thermal throttling, memory usage, network loss, latency, battery consumption, and package size.
- Record dedicated-server CPU, memory, tick rate, outgoing bandwidth, and per-player replication cost.
- Increase player counts gradually: 2 → 8 → 16 → 32 → 50 → 100, only if measured results support each step.

## 12. Quality Assurance Plan

### Functional tests
- Login/lobby, match join/leave, reconnect, match lifecycle.
- Movement, camera, collisions, shooting, reload, inventory, zone, winner selection.
- Solo/squad edge cases: disconnects, simultaneous eliminations, teammate revival.

### Multiplayer tests
- High ping, packet loss, jitter, reconnects, server crashes, host migration expectations (if applicable).
- Hit registration, desync, inventory races, duplicate pickup, zone synchronization.
- Server-side exploit and RPC validation tests.

### Mobile tests
- Different aspect ratios, touch layouts, low-memory devices, incoming calls, app backgrounding, thermal behavior, and permissions.

### Automation
- Unit tests for damage, inventory constraints, zone geometry, and match rules.
- Unreal functional tests and automated multi-client smoke scenarios.
- Build verification, crash reporting, and performance regression dashboards.

## 13. Setup — Developer Workstation

1. Install Epic Games Launcher and a supported Unreal Engine 5 version.
2. Install Visual Studio with the required C++ game-development toolchain on Windows.
3. Install Git and Git LFS; configure LFS for binary assets (`.uasset`, `.umap`, etc.).
4. Create a **Games → Third Person → C++** Unreal project named `ProjectLastStand`.
5. Enable required platform SDKs and plugins only after checking compatibility.
6. Open the project, compile, and test the starter level.
7. Set up a dedicated-server build using the appropriate Unreal source/build workflow for the chosen engine version.
8. Run a local server and connect two clients before adding additional gameplay features.
9. Configure Android/iOS toolchains later using the exact documentation for the selected engine version. iOS signing and distribution generally require access to Apple tooling and developer credentials.

> This repository is a **design and implementation blueprint**, not a completed or runnable game. It does not include a `.uproject`, gameplay code, assets, or packaged APK.

## 14. Release, Privacy, and Compliance

- Use original or properly licensed art, music, character designs, and maps.
- Publish a privacy policy and terms of use before collecting player data.
- Minimize personal data; secure authentication, user-generated content, and voice/chat systems.
- Include reporting, blocking, moderation, and age-appropriate safeguards for online interactions.
- Verify current Google Play, Apple App Store, and regional requirements before submission.
- Use legitimate platform signing, secure backend deployment, and a vulnerability disclosure process.

## 15. Future Features

- Ranked seasons and leaderboards
- Clan system, friend invites, and private rooms
- Cross-platform account progression
- Spectator/replay and kill-cam tools
- Cosmetics, battle pass, and live events (subject to fair monetization and policy review)
- More maps, weather variation, and seasonal modes

## 16. Contribution Guidelines

1. Create an issue describing the feature or bug.
2. Work in a dedicated feature branch.
3. Add tests for gameplay and networking changes.
4. Run formatting, automated checks, and a two-client smoke test.
5. Open a pull request with screenshots or recordings where relevant.
6. Never commit credentials, signing keys, or proprietary assets.

## 17. Project Status

**Status:** Planning / README specification.

**Next milestone:** Create the UE5 project and implement the first two-player dedicated-server combat prototype.

## 18. License

**License not yet selected.** Decide on code and asset licensing before publishing or accepting external contributions. Third-party assets retain their own licenses.
