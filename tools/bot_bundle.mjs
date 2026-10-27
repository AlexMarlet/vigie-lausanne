// Prépare la fonction Supabase du bot Telegram : copie le moteur de l'app et la liste des arrêts et des lignes dans
// supabase/functions/telegram/ (fichiers générés, non suivis par git). Lancé par .github/workflows/bot.yml.
//   node tools/bot_bundle.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FN = join(ROOT, "supabase", "functions", "telegram");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

copyFileSync(join(ROOT, "core", "vigie-core.js"), join(FN, "vigie-core.js"));
const stops = read("collector/stops.json"), lignes = read("collector/lignes.json");
writeFileSync(join(FN, "data.js"),
  "// Généré par tools/bot_bundle.mjs depuis collector/stops.json et collector/lignes.json : ne pas modifier.\n" +
  "export const STOPS = " + JSON.stringify(stops) + ";\n" +
  "export const LIGNES = " + JSON.stringify(lignes) + ";\n");
console.log(`fonction telegram : ${stops.length} arrêts, ${lignes.length} lignes`);
