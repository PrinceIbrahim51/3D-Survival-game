# Test report: pre-deployment round, 14 November 2026

One round of regression, sanity, smoke, functional and load testing was run on the final code before it was deployed. Everything passed.

## Summary

| Type | What was run | Result |
| --- | --- | --- |
| Regression (unit and rule tests) | `npm test` | 94 of 94 passed |
| Sanity | Static build, then `scripts/check-server.mjs` against the built output: join, match start, inputs acknowledged, 30 snapshots/s, connection hand-over; all client files served | Passed |
| Smoke | `scripts/browser-smoke.mjs`: two browsers in one private room see each other move; one leaves, the other wins | 6 of 6 passed |
| Functional | `scripts/playthrough.mjs`: every feature played through a real browser, desktop and phone layouts | 101 of 101 passed |
| Load | `scripts/loadtest.mjs`: real connections, 16 to 100 players | Within budget at every size |
| Deployment check | `GET /api/ws?selftest=full` on the live site after deploying | See the end of this report |

## Problems reported from play-testing, and what was done

| Report | Cause found | Fix | Covered by |
| --- | --- | --- | --- |
| Cannot drive the auto or any other vehicle | Vehicles were scenery; driving had not been built yet | Autos and lorries are now real vehicles: get in and out with E, drive with W A S D, passengers can shoot, vehicles take damage and explode | `tests/vehicle.test.js` (10 tests); functional checks "vehicles" on desktop and touch |
| Cannot swap guns | Two separate causes. On desktop, F acted on the nearest item of any kind, so a spare bandage or ammo box lying closer than the weapon swallowed the key press. On phones, weapon slots reacted to click events, which browsers only produce for the first finger, so tapping a slot with a thumb on the joystick did nothing | F now takes the weapon named in the on-screen prompt. All in-game HUD buttons react to pointer-down, so they work with any finger | Functional checks "F swaps the weapon in hand..." and "tapping a weapon slot while moving switches weapon" |
| Cannot use med kits | Same touch cause as above: the Med Kit and Bandage buttons ignored a second finger. The keyboard path (4, 5, H) worked | Fixed with the same change | Functional checks "5 starts using the med kit", "the med kit restores full health", "tapping Med Kit while moving starts healing" |

Other defects found and fixed during this round:

- Pickup, vehicle and revive prompts refreshed every sixth frame, so on a slow device they could lag by more than a second. They now refresh ten times a second regardless of frame rate.
- At very low frame rates the server could fill an input gap with a neutral step that stood a crouching player up. Stance is now kept.

## Functional coverage

101 checks, each a concrete action and its expected result:

- **Menu and profile (5):** page loads, no connection before playing, profile panel, outfits locked by level, leaderboard request.
- **Starting a match (4):** lobby, HUD, players/loot/vehicles present, starting health.
- **Movement (6):** walk, prediction in step with the server, sprint, crouch, jump, mouse look.
- **Weapons (16):** pickup, ammunition, firing, reload, second slot, switching with 1/2/3/Q, swap with F while other items lie closer, swap back, drop, pick up again, attachment fitted and shown.
- **Healing (6):** med kit start, progress bar, full heal and consumption, bandage, message when none is carried.
- **Throwables (4):** carry, throw, explosion, smoke cloud.
- **Vehicles (10):** prompt, get in, panel, drive, speedometer, steer, prediction in step, brake, get out, unhurt and next to the vehicle.
- **Interface (4):** map, settings, no movement while settings are open, close.
- **Connection (2):** a dropped connection resumes the same match with inventory intact.
- **Elimination (4):** placing, spectating, next player, leave to menu.
- **Touch layout (18):** joystick, look, weapon slot and Med Kit tapped while moving, heal completes, FIRE, CROUCH, TAKE swap, DRIVE/EXIT, joystick driving, map, pause.
- **Team play (7):** Duo lobby, team-mate present, team panel, knock-down, notice, bot team-mate revives, kill feed.
- **Watching and private rooms (8):** message when nothing is live, watching a live match, viewer is not counted as a player, invite link shown, link fills in the room, both in one lobby, match starts for both.
- **Finishing a match (6):** results, placing, experience awarded, table, profile updated, new match afterwards.
- **General (1):** no errors in the browser console during any of it.

## Load test

One server process, real WebSocket clients sending 60 inputs a second each. The simulation budget is 33.3 ms per tick.

| Players | Humans / bots | Tick average | Tick worst | Budget used | Data per client | Without compression |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 16 | 16 / 0 | 0.40 ms | 2.8 ms | 1.2% | 5.6 KB/s | 19.6 KB/s |
| 16 | 4 / 12 | 0.32 ms | 3.2 ms | 1.0% | 4.6 KB/s | 17.6 KB/s |
| 32 | 32 / 0 | 0.39 ms | 2.8 ms | 1.2% | 9.3 KB/s | 33.1 KB/s |
| 32 | 8 / 24 | 0.43 ms | 4.4 ms | 1.3% | 8.3 KB/s | 32.8 KB/s |
| 50 | 50 / 0 | 0.56 ms | 1.5 ms | 1.7% | 12.3 KB/s | 45.2 KB/s |
| 50 | 13 / 37 | 0.47 ms | 4.2 ms | 1.4% | 11.8 KB/s | 48.4 KB/s |
| 100 | 100 / 0 | 1.07 ms | 5.0 ms | 3.2% | 25.4 KB/s | 92.5 KB/s |
| 100 | 25 / 75 | 0.80 ms | 6.2 ms | 2.4% | 23.0 KB/s | 90.1 KB/s |

The server has ample headroom at 100 players per match. The limit in practice is the island, which is sized for about 30.

## What this round could not cover

- **Real hardware.** The browser tests ran in headless Chromium with software rendering at roughly 10 frames a second. They prove that features work, not how aiming, recoil and driving feel at 60 frames a second, and not how the game performs on a particular phone.
- **Sound.** Effects are generated in code and were not listened to.
- **The live site in a real browser.** This test environment cannot reach the deployed address directly, so the deployment was verified through its self-test endpoint and by fetching its files, not by playing on it.
- **Many server instances.** On Vercel, matches live in one function instance. Behaviour when traffic is high enough for Vercel to start several instances was not tested.
- **Long sessions.** No test ran longer than a few minutes.

## Running the round again

```bash
npm test                         # regression
npm run build && STATIC_DIR=public npm start &
npm run check -- http://localhost:3000   # sanity
npm install --no-save playwright && npx playwright install chromium
npm run test:browser             # smoke
npm run test:play                # functional (about 8 minutes without a GPU)
npm run test:load                # load
```
