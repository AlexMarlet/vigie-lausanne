-- Vigie — effacement automatique (à exécuter une fois, après schema.sql).
-- Supprime chaque heure les signalements de plus de 48 h et le journal anti-spam de plus d'1 h.
-- Supabase demande de confirmer parce que le script contient une suppression : c'est voulu.
-- Si l'extension est refusée : Integrations > Cron > Enable, puis relance ce script.
-- Relancer ce script remplace les tâches existantes (mêmes noms) : pas de doublon.

create extension if not exists pg_cron;

select cron.schedule('vigie-purge-signalements', '17 * * * *',
  $$delete from public.signalements where at < now() - interval '48 hours'$$);

select cron.schedule('vigie-purge-appareils', '*/15 * * * *',
  $$delete from vigie_private.appareils where at < now() - interval '1 hour'$$);
