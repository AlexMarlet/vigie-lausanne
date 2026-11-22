# Vigie Lausanne

[![Tests](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/ci.yml)
[![Déploiement](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/pages.yml/badge.svg)](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/pages.yml)

Carte communautaire des **contrôles** et **perturbations** sur le réseau de transports du Grand Lausanne, un peu comme Waze.
Chacun signale en deux gestes ce qu'il voit à un arrêt, avec la ligne et le sens s'il les connaît ; la carte affiche chaque signalement avec un **indice de confiance** : plus il y a de signalements récents au même endroit, plus le point est gros et rouge ; plus ils vieillissent, plus il pâlit.
Avec la ligne et le sens, la carte montre aussi **où les contrôleurs sont probablement maintenant**, à partir de leur vitesse habituelle sur cette ligne, **apprise** sur tous les signalements.

**App : https://vigie-lausanne.ch**

Projet personnel et non officiel, sans lien avec les transports publics de la région lausannoise (tl).

## Installer l'app

Vigie est une app web installable (PWA) : pas besoin de store.

- **Android (Chrome)** : ouvrir le site, puis toucher « Installer » dans le bandeau ou dans le menu ⋮.
- **iPhone (Safari)** : ouvrir le site, puis Partager → « Sur l'écran d'accueil » → Ajouter.

L'app s'ouvre ensuite en plein écran avec son icône, comme une app classique.

## Utiliser l'app

- **Signaler** : toucher un arrêt (ou son nom ; un appui jusqu'à 22 px du point suffit) ou le bouton Signaler, puis la ligne et le sens si on les connaît. Quand une fiche est ouverte, un appui à côté des arrêts la ferme.
- **Position estimée** : toucher un anneau pointillé, puis « Je les vois ici » (confirme et relance l'estimation depuis cet arrêt) ou « Pas ici ».
- **Filtres** Contrôles / Perturbations / Estimations sous la barre du haut ; **thème** clair ou sombre avec le bouton lune / soleil (la légende permet de revenir au réglage du téléphone).

## Indice de confiance

Pour chaque arrêt et chaque type (contrôle / perturbation) :

```
poids d'un signalement   w = base × 0,5^(âge / demi-vie)
« plus là » postérieur    w ← w × (1 − 0,75)
confiance                C = 1 − (1 − w1)(1 − w2)…(1 − wn)
```

| Paramètre | Valeur |
|---|---|
| base app / Telegram | 0,60 / 0,45 |
| demi-vie contrôle / perturbation | 20 / 45 min |
| durée maximale | 2 h / 4 h |
| seuil d'affichage | 8 % |
| niveaux | faible < 35 % ≤ moyenne < 65 % ≤ forte |

Une même personne ne compte qu'une fois par arrêt. Réglages : `CFG` en haut de `core/vigie-core.js`.

## Position estimée

Pour un contrôle signalé à un arrêt avec sa ligne (et, mieux, son sens), il y a `a` minutes :

```
arrêts parcourus depuis     k ~ Poisson(λ × a)        λ = arrêts par minute sur cette ligne
restés sur la ligne/le sens × 0,85 par arrêt           sinon : autre ligne, demi-tour, fin du contrôle
présence à k arrêts plus loin  p = w × part × P(k) × 0,85^k   w = poids du signalement (ci-dessus)
```

| Sens | `part` de l'estimation |
|---|---|
| signalé | 85 % dans ce sens, 15 % dans l'autre (demi-tour) |
| confirmé (revus plus loin dans ce sens) | 100 % dans ce sens ; sur un tronc commun à deux branches, chacune selon sa part des courses |
| inconnu | moitié par sens de circulation ; dans un sens à deux branches, chaque branche selon sa part des courses |

**Revus plus loin.** Un nouveau contrôle sur la même ligne, 1 à 45 min plus tard, plus loin dans un sens possible
(le sens signalé ou déjà confirmé s'il est connu ; au plus 12 arrêts et 1,5 arrêt/min), par exemple avec « Je les vois
ici » sur une estimation, signifie qu'ils se sont déplacés : le signalement d'origine perd 75 % de son poids (point
réduit) et ne projette plus rien ; l'estimation repart du nouvel arrêt (à sa position dans le parcours, utile sur les
boucles), dans le sens confirmé (`linkMovements`). Un déplacement possible dans les deux sens (boucle parcourue dans les
deux sens) donne la position mais pas le sens. Un signalement daté dans le futur (horloge du téléphone) n'est relié
qu'une fois l'heure atteinte.

Plusieurs signalements se combinent comme pour la confiance (1 − Π(1 − p)). Un « pas ici » / « plus là » à un arrêt
estimé y divise l'estimation par 4 ; à l'arrêt du signalement, il ne l'arrête pas (ils en sont repartis). La carte
trace le trajet probable (plus pâle dans le sens le moins probable) et entoure les arrêts de la zone la plus probable
(au moins la moitié du maximum de ce signalement, donc pas dans l'autre sens). Plus d'estimation après 45 min.

**Apprentissage.** Chaque heure, la base (`vigie_private.apprendre()`) relit tous les signalements depuis le lancement :
deux contrôles signalés à la suite sur la même ligne, dans le même sens, à 2–40 min d'écart et 0–10 arrêts plus loin,
donnent un couple (arrêts, minutes). Garde-fous, puisque ces signalements sont publics : un couple plus rapide que
1,5 arrêt/min est ignoré, et au plus 20 couples par ligne, sens et jour sont comptés ; l'app borne aussi la vitesse
entre 1 et 15 min par arrêt. La table publique `tendances` en garde les totaux par ligne et par sens. L'app en
tire la vitesse : a priori 1 arrêt / 3 min (poids : 30 min d'observation), puis
`λ_réseau = (10 + Σarrêts) / (30 + Σminutes)` et `λ_ligne = (30 × λ_réseau + arrêts) / (30 + minutes)`.
Une ligne peu observée suit donc la moyenne du réseau. La légende de l'app affiche ces vitesses.

## Structure

| Dossier | Contenu |
|---|---|
| `web/` | L'app : gabarit HTML, service worker, manifest, icônes, page Confidentialité ; page privée du tableau d'apprentissage (`apprentissage/`) |
| `core/` | Moteur partagé : parseur de messages, confiance, sens, position estimée, vitesse apprise ; tests |
| `supabase/` | Schéma de la base (`schema.sql`), tâches horaires : archive anonyme et apprentissage (`purge.sql`), tests ; bot Telegram (`functions/telegram/`), statistiques d'apprentissage (`functions/stats/`) |
| `tools/` | Réseau tl depuis l'horaire officiel (`fetch_gtfs.py`, `build_network.py` → `reseau.json`), arrêts historiques et alias (`arrets.json`), construction du site (`build_app.py`), installation du bot (`bot_telegram.py`, `bot_bundle.mjs`), vérifications |
| `collector/` | Liste d'arrêts et de lignes partagée ; variante du bot avec un compte Telegram ordinaire (`collector.py`) |

## Réseau (horaire officiel)

`tools/reseau.json` contient les 460+ arrêts et les 47 lignes : celles des tl (métro, bus, lignes de nuit) et le
**LEB** (train Lausanne-Flon – Echallens – Bercher, « R20 » dans l'horaire), avec, pour chaque sens, l'ordre des arrêts.
Il est produit à partir de l'horaire officiel suisse au format GTFS
([opentransportdata.swiss](https://opentransportdata.swiss)) par le workflow **Réseau tl**, chaque lundi : il télécharge
le dernier fichier, extrait les lignes circulant les 14 prochains jours, et ne fait un commit (puis un redéploiement)
que si les arrêts ou les lignes ont changé.

- Sens d'une ligne = un terminus des parcours réguliers (au moins 10 % des courses). Les courses partielles comptent pour le parcours complet (un terminus intermédiaire n'est proposé que s'il reçoit au moins 35 % des courses), une rallonge rare (dépôt, moins de 15 %) est ignorée, une branche devient un sens à part. Un arrêt liste les lignes qui y proposent un sens (sinon toutes celles qui y passent).
- `tools/arrets.json` garde les identifiants des arrêts historiques (retrouvés par position) et les alias du groupe (« st f », « poly »…). Pour ajouter un alias : une entrée `{"id": …, "alias": […]}`.
- LEB : ses trains forment une seule ligne « LEB » (ses bus de remplacement sont ignorés) ; ses gares du Flon, de Chauderon et de Prilly-Chasseur rejoignent les arrêts de bus du même nom. Un message écrit « LEB » ou « R20 ». Deux arrêts du même nom (« Bel-Air » à Lausanne et la gare du LEB à Cheseaux) : la ligne citée choisit.
- En local : `python3 tools/fetch_gtfs.py gtfs.zip && python3 tools/build_network.py gtfs.zip` (fichier d'environ 280 Mo).

## Développer en local

Prérequis : Node.js 20+ et Python 3.10+.

```bash
npm ci                 # librairies et polices, versions figées
npm run build          # construit le site dans dist/
npm run serve          # http://localhost:8080
npm test               # tests du moteur et du parseur
```

`npm run build` utilise la base définie dans `vigie.config.json`. Avec `VIGIE_OFFLINE=1`, l'app fonctionne en local (signalements gardés sur l'appareil) avec des données de démonstration.
Sur le site en ligne, la démo reste accessible avec `?demo` à la fin de l'adresse.

## Mise en ligne

### 1. Base de données (Supabase, offre gratuite)
1. Créer un projet sur [supabase.com](https://supabase.com), région **Central Europe (Zurich)**.
2. SQL Editor → New query : coller `supabase/schema.sql` → Run. Le script peut être relancé : il met à jour une base existante sans perdre de données, tâches planifiées comprises.
3. Nouvelle requête : coller `supabase/purge.sql` → Run (chaque heure : archive anonyme après 48 h, calcul des tendances ; Supabase demande de confirmer la suppression, c'est voulu).
4. Settings → API Keys : copier la clé **publishable** (`sb_publishable_…`). L'URL du projet est dans le bouton **Connect**.

La clé publishable est faite pour être publique. La clé **secrète** ne va jamais dans l'app ni dans ce dépôt.

### 2. Connexion de l'app à la base
Renseigner l'URL et la clé publishable dans `vigie.config.json`. Ces deux valeurs sont publiques par conception : elles finissent de toute façon dans le code du site, et la sécurité repose sur les règles d'accès du schéma.
Des variables GitHub `SUPABASE_URL` / `SUPABASE_KEY` (Settings → Secrets and variables → Actions → Variables) remplacent ce fichier si elles existent. `VIGIE_CONTACT` (facultatif) affiche le responsable dans la page Confidentialité.

Le build refuse de publier une clé secrète par erreur. `VIGIE_OFFLINE=1 npm run build` construit une version locale, sans base.

### 3. Hébergement (GitHub Pages)
1. Settings → Pages → Source : **GitHub Actions**.
2. Pousser sur `main` (ou Actions → Déploiement → Run workflow).

À chaque déploiement, `tools/check_supabase.py` vérifie en lecture seule que la table et la fonction `signaler()` existent. Une fois le site publié, `tools/smoke_test.py` l'ouvre dans un Chrome mobile et contrôle la connexion à la base, le fonctionnement hors ligne, l'installabilité et l'absence d'erreur, sans rien écrire.

## Bot Telegram

Avec l'accord de ses admins, le bot lit le groupe Telegram de signalement et met ses messages sur la carte.

**Fonctionnement.** Telegram envoie chaque message du groupe à la fonction Supabase `telegram` (webhook,
`supabase/functions/telegram/`) :

- le message est lu avec le même parseur que l'app : type (contrôle, perturbation, fin), arrêt, ligne, sens. Une réponse
  « partis », « toujours là » ou « rétabli » à un signalement prend l'arrêt du message auquel elle répond (règles plus
  strictes que le parseur : « merci », « ok » ou « c'est bon » en réponse ne comptent pas) ;
- ligne et sens : toutes les lignes citées sont prises en compte (« ligne 6 et 7 et M2 », « 6/7 », « (7,8,19) »),
  seulement si elles passent à l'arrêt ; le sens écrit (« direction Chailly ») choisit parmi elles, et sans ligne citée
  qui passe à l'arrêt, parmi les lignes de l'arrêt (« M2 … EPFL » → M1). « direction centre / Lausanne / ville » donne
  le sens qui rejoint le plus vite le centre ; « direction X » quand la ligne ne passe pas à X : un arrêt de la même
  commune (« direction Pully », « St-Sulpice ») ou dont le nom contient X (« Malley »), sinon le seul sens qui s'approche
  de X (« Bel-Air, 7 direction St-François » → Val-Vert, par Riponne). Plusieurs possibilités : ligne ou sens inconnus,
  rien n'est deviné ;
- **suites** : le message suivant de la même personne, dans les 15 minutes, complète son signalement. « 3 à Georgette »
  puis « ils montent dans le 8 » : la ligne 8 s'ajoute au même signalement (pas de deuxième point). « M2 dir
  Croisettes » sans arrêt attend l'arrêt du message suivant (« à la Riponne ») ; « descendus à Délices » garde la ligne
  et le sens d'avant ; « partis » seul termine son signalement. Une réponse qui donne la ligne ou le sens d'un
  signalement (« montés dans le 18 direction Clochatte ») le complète aussi, quel que soit son auteur. Pour relier ces
  messages, la fonction garde 30 minutes au plus, dans le schéma privé (`vigie_private.suites`), une empreinte salée
  de l'auteur avec l'arrêt, la ligne et le sens de son dernier message, jamais le texte ni l'identifiant Telegram
  (effacement par le bot et par la tâche `vigie-purge-suites`, toutes les 5 minutes). Sans base joignable, chaque
  message est placé seul ;
- plusieurs arrêts reliés par « et » (« 2 équipes à Vieux-Moulin et Grande-Borde direction Le Mont ») : un
  signalement à chacun, avec la même ligne et le même sens visé ;
- ignorés : les questions (« il y en a encore à Ours ? ») et les messages hors sujet (un fait d'hier, une longue
  discussion sans arrêt ni ligne) ;
- les messages du bot de signalement anonyme du groupe (🚏 arrêt, ➡️ direction, 🚌 lignes) sont compris aussi. Telegram ne
  transmet les messages d'un autre bot que si notre bot est **admin** du groupe (sans aucun droit) et a le mode
  **bot-to-bot** activé dans @BotFather (en plus du mode confidentialité désactivé) ;
- s'il cite un arrêt, il devient un signalement `telegram` (poids 0,45 contre 0,60 pour l'app) à l'heure du message. Ni le
  texte ni l'auteur ne sont enregistrés : seulement une empreinte du message (anti-doublon) et une empreinte « personne +
  arrêt + jour » (une seule voix), salées et non réversibles. Un message modifié met à jour son signalement ;
- le bot ne poste rien dans le groupe. En privé, il explique ce qu'il fait et répond ce qu'il comprend d'un message, sans
  rien enregistrer (pratique pour tester). Ajouté à un autre groupe, il en sort aussitôt.

Si la fonction ne répond pas, Telegram garde les messages jusqu'à 24 h et les renvoie. Il les envoie un par un, dans
l'ordre (une suite doit voir le message d'avant). Coût : une invocation par message (offre gratuite Supabase : 500 000
par mois). Le bot ne voit pas les messages envoyés avant son arrivée.

**Installation** (une fois) :

1. Dans Telegram, [@BotFather](https://t.me/BotFather) : `/newbot` (nom « Vigie Lausanne », identifiant finissant par
   `bot`) → copier le **jeton**. Puis `/setprivacy` → ce bot → **Disable** : il lira tous les messages du groupe sans
   être admin (à faire avant de l'ajouter au groupe, sinon il faut le retirer et le ré-ajouter).
2. Supabase : [Access Tokens](https://supabase.com/dashboard/account/tokens) → *Generate new token*, de préférence limité
   au projet Vigie avec les droits **Edge Functions** et **Edge Function Secrets** en lecture-écriture → copier.
3. GitHub, dépôt → Settings → Secrets and variables → Actions → *New repository secret* : `TELEGRAM_BOT_TOKEN` (le jeton
   du bot) et `SUPABASE_ACCESS_TOKEN`.
4. Les admins ajoutent le bot au groupe comme **admin sans aucun droit** (un simple membre suffit s'il n'y a pas de bot
   de signalement anonyme dans le groupe), et l'exemptent du bot anti-spam s'il y en a un. Dans @BotFather, activer
   aussi le mode bot-to-bot pour qu'il lise les messages du bot de signalement anonyme.
5. Dans le groupe, appui long (ou clic droit) sur n'importe quel message → **Copier le lien**. GitHub → secret
   `TG_CHAT_ID` = ce lien (ou l'identifiant `-100…` du groupe), puis Actions → **Bot Telegram** → *Run workflow* : il en
   tire l'identifiant, vérifie le bot dans le groupe (« « … » · N membres · bot : administrator »), déploie la fonction,
   branche Telegram dessus et la teste en ligne (annotations du run). Rien n'est déployé si le lien est faux ou si le
   bot n'est pas dans ce groupe. Sans `TG_CHAT_ID`, le workflow liste les groupes où le bot vient d'arriver (« Groupe
   trouvé : … → TG_CHAT_ID = -100… »), seulement tant que la fonction n'est pas branchée (sinon c'est elle qui reçoit
   ces messages).
6. @BotFather → `/setjoingroups` → **Disable** : plus personne ne peut ajouter le bot à un autre groupe.

**Groupe de test.** Si les admins essaient d'abord le bot dans un petit groupe : créer le secret `TG_TEST_CHAT_ID` avec le
lien d'un message de ce groupe ou son identifiant (plusieurs : séparés par des virgules) et lancer le workflow. Dans ce
groupe, le bot répond à chaque signalement ce qu'il a compris, sans rien enregistrer. Tant que `TG_CHAT_ID` n'est pas
défini, il reste muet dans les autres groupes (il ne les quitte pas) ; une fois ajouté au groupe de signalement : étape
5. Ne jamais mettre un groupe de test dans `TG_CHAT_ID` : ses messages iraient sur la carte, et le bot quitterait le vrai
groupe dès son arrivée (le workflow refuse un même groupe dans les deux secrets).

Ensuite tout est automatique : une modification du bot, du parseur ou du réseau tl le redéploie. Journal (sans le texte
des messages) : Supabase → Edge Functions → `telegram` → Logs.

`collector/collector.py` fait la même lecture avec un compte Telegram ordinaire (Telethon, serveur allumé en
permanence) : seulement pour un groupe où un bot n'est pas possible, et jamais en même temps que le bot.

## Statistiques d'apprentissage

La fonction Supabase `stats` (déployée avec le bot) lit tout l'historique, archive anonyme comprise, dans une
transaction en lecture seule, et ne rend que des agrégats : volumes par jour et par heure, arrêts, lignes, couples de
contrôles qui servent à apprendre la vitesse, tendances apprises, durée jusqu'au « partis », confirmations. Elle exige
une clé tirée du jeton du bot (HMAC « vigie-stats ») ; sans elle, 401.

Le workflow **Statistiques** (à la demande) l'appelle et chiffre le résultat pour un certificat donné (CMS, AES-256) :
le journal, public, ne contient que le texte chiffré, lisible seulement avec la clé privée du destinataire. Mode
d'emploi en tête de `.github/workflows/stats.yml`.

### Tableau d'apprentissage en direct (page privée)

`https://vigie-lausanne.ch/apprentissage/` (`web/apprentissage/`) montre ce que le modèle apprend : vitesse des
contrôleurs (réseau et lignes), couples de contrôles jugés retenus ou écartés, courbe d'apprentissage, heures et
jours, arrêts, lignes, contenu des messages. La page lit la fonction `stats` depuis le navigateur (CORS limité au
site) et se recalcule à chaque nouveau signalement (temps réel de la table `signalements`), au moins toutes les
5 minutes tant qu'elle est ouverte ; la vitesse du modèle, elle, est recalculée chaque heure par la base.

- **Accès** : la même clé que `stats`. Le lien personnel `…/apprentissage/#cle=…` la garde sur l'appareil
  (localStorage) et l'efface aussitôt de la barre d'adresse ; le fragment `#…` n'est jamais envoyé au serveur.
  Sans clé, la page n'affiche qu'un champ d'accès. Elle n'est ni liée depuis l'app, ni référencée (`noindex`), ni
  mise en cache par le service worker de l'app.
- **Depuis l'app** : sur l'appareil qui garde la clé, un lien « Apprentissage » apparaît en bas de la légende.
  Ailleurs (première fois, ou dans l'app installée sur iPhone, qui a son propre stockage), cinq appuis rapides sur
  le titre « Vitesse des contrôles, apprise » de la légende ouvrent la page, qui demande la clé.
- **Obtenir le lien** : workflow **Tableau d'apprentissage** avec un certificat (mode d'emploi en tête de
  `.github/workflows/tableau.yml`) ; le lien sort chiffré, comme les statistiques.
- **Changer la clé** (lien diffusé par erreur) : remplacer `"vigie-stats"` par une nouvelle étiquette dans
  `supabase/functions/stats/index.ts`, `stats.yml` et `tableau.yml`, puis redemander le lien.
- **Vérification** : après chaque déploiement, le même workflow ouvre la page en ligne avec la vraie clé et vérifie
  chargement, graphiques, mise en page et temps réel, sans rien écrire des statistiques dans le journal.

## Tests

| Commande | Vérifie |
|---|---|
| `node core/test-core.js` | parseur de messages (72 cas, sur les 463 arrêts), confiance, sens, position estimée, vitesse apprise |
| `node core/test-bot.mjs` | bot Telegram : signalements tirés des messages, réponses « partis », suites (« ils montent dans le 8 »), questions et hors-sujet, sens approché, deux arrêts dans un message, empreintes, autres groupes, groupe de test, messages privés |
| `npx deno@2.9.6 run --allow-env --allow-net --allow-read --node-modules-dir=none tools/test_suites.ts` | mémoire des suites du bot sur un vrai PostgreSQL : table, lecture, mise à jour, rien au-delà de 30 min (`SUPABASE_DB_URL`, après `node tools/bot_bundle.mjs`) |
| `python3 collector/test_parser.py` | la version Python du parseur donne les mêmes résultats |
| `python3 tools/test_network.py` | extraction du réseau sur un petit GTFS fabriqué (sens, branches, courses partielles, fusion d'arrêts) |
| `python3 supabase/test_schema.py` | mise à jour depuis l'ancien schéma, règles d'accès, anti-spam, sens, archive anonyme, apprentissage, sur un vrai PostgreSQL |
| `python3 tools/test_tableau.py` | page Apprentissage dans Chromium, données fictives : accès privé, lien personnel, chiffres et graphiques, mise en page du téléphone à l'ordinateur, mise à jour en temps réel, clé refusée (après `python3 tools/build_app.py`) |

La CI (`.github/workflows/ci.yml`) les lance à chaque push, avec une base PostgreSQL 17 jetable.

## Feuille de route

- **Telegram** : bot prêt (voir « Bot Telegram »), à installer quand les admins du groupe l'acceptent.
- **Play Store** : possible via une Trusted Web Activity (PWABuilder). Demande un compte développeur (25 $ une fois), un test fermé de 14 jours avec 12 testeurs pour un nouveau compte personnel, et un nom de domaine propre.
- **App Store** : compte développeur à 99 $ par an, et Apple refuse les apps qui se contentent d'emballer un site (règle 4.2) : il faudrait des fonctions natives en plus.

## Données et cadre légal

- Seuls le type, l'arrêt, la ligne, le sens et l'heure sont publics, pour l'app comme pour le groupe Telegram (dont le bot n'enregistre ni le texte ni l'auteur des messages ; pour relier deux messages qui se suivent, il garde 30 minutes au plus une empreinte salée de l'auteur, dans un schéma privé). L'identifiant d'appareil sert uniquement à l'anti-spam, reste dans un schéma privé et disparaît après 1 heure. Après 48 h, un signalement est anonymisé (sans empreinte, heure à la minute) et gardé pour apprendre la vitesse des contrôles ; seules les moyennes par ligne sont publiques. Détails : `web/confidentialite.html`.
- En Suisse, signaler des contrôleurs n'est pas interdit en soi, contrairement à la France. L'app refuse volontairement photos, descriptions et texte libre pour protéger les agents.
- Fond de carte épuré par défaut : [OpenFreeMap](https://openfreemap.org) (styles Positron et Dark, gratuits, sans clé ni limite), © OpenMapTiles, données © contributeurs OpenStreetMap. Quelques couches sont masquées et recolorées dans `web/index.template.html` (`FOND_HIDE`, `FOND_PAINT`).
- Plan des lignes en option (légende de l'app) : [ÖPNVKarte](https://öpnvkarte.de) (memomaps.de, CC BY-SA). memomaps demande d'héberger soi-même la carte en cas de fort trafic.
- Arrêts, lignes et sens : horaire officiel suisse, [opentransportdata.swiss](https://opentransportdata.swiss) ([conditions d'utilisation](https://opentransportdata.swiss/fr/terms-of-use/)), source citée dans la légende de l'app. Contours des communes et du lac (aperçu Claude) : swisstopo / OFS, via [swiss-maps](https://github.com/interactivethings/swiss-maps).
- Polices sous licence SIL Open Font License (`web/fonts/`). Leaflet (BSD-2-Clause), MapLibre GL (BSD-3-Clause), maplibre-gl-leaflet (ISC), supabase-js (MIT) et d3 (ISC, page Apprentissage) sont installés par `npm ci`.

## Licence

Aucune licence pour l'instant : le code est consultable mais tous droits réservés.
