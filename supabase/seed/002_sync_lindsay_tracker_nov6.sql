-- Nov 6, 2026: brought the app in line with the live Google Sheet "Lindsay's (current) Task Tracker"
-- (edited Nov 4). Reverts wording added during the first import and applies the two status changes
-- made in the sheet since the Oct 30 download. Already run on the live project.
begin;
select set_config('init.actor', 'import: Lindsay''s (current) Task Tracker, Nov 6 sync', true);

update public.init_projects set name = 'New Product Intro - Loft Chair', priority = 'High',
  summary = 'REGIONAL ROLL OUT ONLY (widely available but not pushed outside NW. Available in Zone 2 June 2027!!! H4/California/Kevin R territory. Launch date 11/2!' where code = 'NPI-LOFT';
update public.init_projects set name = 'New Product Intro - Kono', priority = null, summary = 'Launch date 11/2!' where code = 'NPI-KONO';
update public.init_projects set name = 'New Product Intro - Venu', priority = null, summary = 'Launch date 11/2!' where code = 'NPI-VENU';
update public.init_projects set name = 'Part Numbers', priority = 'High', summary = null where code = 'PN-CLEAN';
update public.init_projects set name = 'Warehouse Management Tool Launch', priority = null, summary = 'Vital AI' where code = 'WMS-01';
update public.init_projects set name = 'Production Order Automation', priority = 'Urgent', summary = null where code = 'POA-01';

update public.init_tasks set title = replace(title, ' (plus Feature List)', ' - Plus Feature List') where title like '% (plus Feature List)';
update public.init_tasks set title = replace(title, ' (plus mechanism)', ' - Plus mechanism') where title like '% (plus mechanism)';
update public.init_tasks set title = title || '?' where title = 'Add new chair into Joel''s Chair Configurator';
update public.init_tasks t set title = 'Continue defining what the part numbers are for the rest of our products'
  from public.init_projects p where p.id = t.project_id and p.code = 'PN-CLEAN' and t.position = 1;
update public.init_tasks set others = 'Paul of Vital' where others = 'Paul (Vital AI)';

update public.init_tasks t set status = 'Done'
  from public.init_projects p where p.id = t.project_id and p.code = 'WMS-01' and t.position in (2, 4) and t.status <> 'Done';
commit;
