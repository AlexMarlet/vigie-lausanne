# Vigie Lausanne

[![Tests](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/ci.yml)
[![Déploiement](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/pages.yml/badge.svg)](https://github.com/AlexMarlet/vigie-lausanne/actions/workflows/pages.yml)

Carte communautaire des **contrôles** et **perturbations** sur le réseau de transports du Grand Lausanne, un peu comme Waze.
Chacun signale en deux gestes ce qu'il voit à un arrêt ; la carte affiche chaque signalement avec un **indice de confiance** : plus il y a de signalements récents au même endroit, plus le point est gros et rouge ; plus ils vieillissent, plus il pâlit.

**App : https://alexmarlet.github.io/vigie-lausanne/**

Projet personnel et non officiel, sans lien avec les transports publics de la région lausannoise (tl).

## Installer l'app

Vigie est une app web installable (PWA) : pas besoin de store.

- **Android (Chrome)** : ouvrir le site, puis toucher « Installer » dans le bandeau ou dans le menu ⋮.
- **iPhone (Safari)** : ouvrir le site, puis Partager → « Sur l'écran d'accueil » → Ajouter.

L'app s'ouvre ensuite en plein écran avec son icône, comme une app classique.

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

## Structure

| Dossier | Contenu |
|---|---|
| `web/` | L'app : gabarit HTML, service worker, manifest, icônes, page Confidentialité |
| `core/` | Moteur partagé : parseur de messages et calcul de confiance, avec ses tests |
| `supabase/` | Schéma de la base (`schema.sql`), effacement automatique (`purge.sql`), tests |
| `tools/` | Construction du site (`build_app.py`), vérification de la base (`check_supabase.py`), données des arrêts et du fond de carte |
| `collector/` | Lecture d'un groupe Telegram (étape suivante du projet, non branchée) |

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
2. SQL Editor → New query : coller `supabase/schema.sql` → Run.
3. Nouvelle requête : coller `supabase/purge.sql` → Run (efface les signalements après 48 h ; Supabase demande de confirmer la suppression, c'est voulu).
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

## Tests

| Commande | Vérifie |
|---|---|
| `node core/test-core.js` | parseur de messages (24 cas) et calcul de confiance |
| `python3 collector/test_parser.py` | la version Python du parseur donne les mêmes résultats |
| `python3 supabase/test_schema.py` | règles d'accès, anti-spam, anti-doublon, sur un vrai PostgreSQL |

La CI (`.github/workflows/ci.yml`) les lance à chaque push, avec une base PostgreSQL 17 jetable.

## Feuille de route

- **Telegram** : `collector/` lit un groupe Telegram et injecte ses messages dans la carte (voir `collector/collector.py`). Non branché pour l'instant.
- **Play Store** : possible via une Trusted Web Activity (PWABuilder). Demande un compte développeur (25 $ une fois), un test fermé de 14 jours avec 12 testeurs pour un nouveau compte personnel, et un nom de domaine propre.
- **App Store** : compte développeur à 99 $ par an, et Apple refuse les apps qui se contentent d'emballer un site (règle 4.2) : il faudrait des fonctions natives en plus.

## Données et cadre légal

- Seuls le type, l'arrêt, la ligne et l'heure sont publics. L'identifiant d'appareil sert uniquement à l'anti-spam, reste dans un schéma privé et disparaît après 1 heure. Détails : `web/confidentialite.html`.
- En Suisse, signaler des contrôleurs n'est pas interdit en soi, contrairement à la France. L'app refuse volontairement photos, descriptions et texte libre pour protéger les agents.
- Fond de carte : [ÖPNVKarte](https://öpnvkarte.de) (memomaps.de, CC BY-SA), données © contributeurs OpenStreetMap. memomaps demande d'héberger soi-même la carte en cas de fort trafic.
- Positions des arrêts : Wikipédia et [transport.opendata.ch](https://transport.opendata.ch). Contours des communes et du lac : swisstopo / OFS, via [swiss-maps](https://github.com/interactivethings/swiss-maps).
- Polices sous licence SIL Open Font License (`web/fonts/`). Leaflet (BSD-2-Clause) et supabase-js (MIT) sont installés par `npm ci`.

## Licence

Aucune licence pour l'instant : le code est consultable mais tous droits réservés.
