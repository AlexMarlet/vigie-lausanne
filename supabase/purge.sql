-- Vigie — tâches automatiques (à exécuter une fois, après schema.sql).
-- Chaque heure : les signalements de plus de 48 h passent dans l'archive anonyme (sans empreinte) et les
-- tendances (vitesse des contrôles par ligne) sont recalculées. Toutes les 15 min : le journal anti-spam de plus
-- d'1 h est effacé.
-- Supabase demande de confirmer parce que le script contient une suppression : c'est voulu.
-- Relancer ce script remplace les tâches existantes (mêmes noms) : pas de doublon.

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('vigie-purge-signalements', '17 * * * *',
  $$select vigie_private.archiver()$$);

select cron.schedule('vigie-purge-appareils', '*/15 * * * *',
  $$delete from vigie_private.appareils where at < now() - interval '1 hour'$$);

select cron.schedule('vigie-apprendre', '23 * * * *',
  $$select vigie_private.apprendre()$$);

-- Vérification : trois lignes attendues, colonne active = true.
select jobname, schedule, command, active from cron.job where jobname like 'vigie-%' order by jobname;
