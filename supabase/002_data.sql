-- Job Hunt: sources, manual postings, cron secret check

create or replace function public.check_cron_secret(s text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from vault.decrypted_secrets where name = 'jobhunt_cron_secret' and decrypted_secret = s and length(s) > 20); $$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'jobhunt_cron_secret');

insert into public.sources (kind, slug, company) values
('greenhouse','coreweave','CoreWeave'),
('greenhouse','togetherai','Together AI'),
('greenhouse','vultr','Vultr'),
('greenhouse','digitalocean','DigitalOcean'),
('greenhouse','cloudflare','Cloudflare'),
('greenhouse','nebius','Nebius'),
('greenhouse','cerebrassystems','Cerebras'),
('greenhouse','groq','Groq'),
('greenhouse','databank','DataBank'),
('greenhouse','flexential','Flexential'),
('greenhouse','switch','Switch'),
('greenhouse','aligneddatacenters','Aligned Data Centers'),
('greenhouse','vantagedatacenters','Vantage Data Centers'),
('greenhouse','edgeconnex','EdgeConneX'),
('greenhouse','stackinfrastructure','STACK Infrastructure'),
('greenhouse','appliedigital','Applied Digital'),
('greenhouse','tensorwave','TensorWave'),
('greenhouse','servicenow','ServiceNow'),
('lever','applieddigital','Applied Digital'),
('lever','voltagepark','Voltage Park'),
('lever','fluidstack','Fluidstack'),
('lever','cologix','Cologix'),
('lever','tierpoint','TierPoint'),
('lever','crusoe','Crusoe'),
('ashby','lambda','Lambda'),
('ashby','crusoe','Crusoe'),
('ashby','fluidstack','Fluidstack'),
('ashby','voltagepark','Voltage Park'),
('ashby','tensorwave','TensorWave'),
('ashby','sfcompute','SF Compute'),
('ashby','nscale','Nscale'),
('amazon','data center technician','Amazon Web Services'),
('amazon','dco technician','Amazon Web Services'),
('amazon','servicenow','Amazon'),
('amazon','it support engineer','Amazon'),
('manual','manual','Manual entries');

insert into public.postings (source_id, external_id, company, title, location, url, lane, pay, score, fit, why, gaps, first_seen_at) values
((select id from public.sources where kind='manual'),'google-wichita-falls','Google','Data Center Technician','Wichita Falls, TX','https://www.google.com/about/careers/applications/jobs/results/131968686683497158-data-center-technician','Data Center','$86K–$119K + bonus + equity','85','Strong','Preferred quals name the Google IT Support Certificate you hold, plus a bachelor''s and 2+ yrs hardware troubleshooting.',array['No direct data center floor/NOC job title yet — lean on Foxconn rack work. Must lift 50 lb and work nights/weekends.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'google-amarillo','Google','Data Center Technician','Amarillo, TX','https://www.google.com/about/careers/applications/jobs/results/131493938178466502-data-center-technician','Data Center','$105K–$146K + bonus + equity','68','Good','You meet all minimum quals (component-level repair, OS/server hardware troubleshooting, networking protocols).',array['Preferred: 4 yrs maintaining server systems and data center/NOC experience — you''re lighter here. Higher-paid, more senior variant than Wichita Falls.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'coreweave-afton','CoreWeave','Data Center Technician','Afton, TX','https://coreweave.com/careers/job?4687824006&board=coreweave&gh_jid=4687824006','Data Center','$65K–$83K','85','Strong','AI-cloud company running the same NVIDIA rack-scale systems you build. You hit both preferred extras (Python, Cisco IOS). Asks for hardware troubleshooting/assembly, Linux, networking, documentation and training — all on your resume.',array['You now cover the preferred Python and Cisco IOS items. Bash and Juniper aren''t on your resume. On-call with 60-min response. Base pay may be below your current role.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'aws-lithia-springs','Amazon Web Services','Data Center Technician, DCO Tech','Lithia Springs, GA','https://www.amazon.jobs/en/jobs/10560893/data-center-technician-dcc-communities-dco-tech','Data Center','$27.98–$48.99/hr','85','Strong','Only 1+ yr server hardware troubleshooting required. Preferred: CS associate degree, critical environment, ticketing system — you have all three.',array['Your daily Cisco port/link troubleshooting covers the preferred Layer 1/2 item. Main hurdle is relocating to the Atlanta area.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'aws-santa-clara','Amazon Web Services','Data Center Technician','Santa Clara, CA','https://www.amazon.jobs/en/jobs/10562844/data-center-technician','Data Center','$32.16–$56.29/hr','68','Good','2+ yrs hardware troubleshooting required (you have it across Foxconn + support roles). Relocation assistance offered.',array['Your daily Cisco switch work counts toward the 1+ yr networking requirement. Bay Area cost of living is high.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'ibm-servicenow-baton-rouge','IBM','Associate Application Developer 2027 – ServiceNow','Baton Rouge, LA','https://www.dice.com/job-detail/f4c112fc-bfb0-49f0-a719-eefafd47764c','ServiceNow','Not listed','85','Strong','True entry-level ServiceNow program for recent bachelor''s grads. Your 2025 CS degree plus the ServiceNow cohort is exactly the profile. IBM trains and certifies you.',array['Your Python covers the language requirement. Git and APIs aren''t on your resume yet. Add them only if you''ve used them.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'procom-servicenow-houston','Procom (client undisclosed)','ServiceNow Administrator 2','NW Houston, TX (hybrid, 3 days on-site)','https://www.dice.com/job-detail/8f478739-3dea-4798-a348-ac188ed71bb9','ServiceNow','Not listed','40','Stretch','Permanent, local, no stated years requirement. Your CS degree, technical writing, and cohort line up with parts of it.',array['Wants ''exceptional'' ServiceNow workflow knowledge, ITIL, Agile, and integrations (JavaScript, web services). Apply after the cohort, ideally with a CSA.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'b12-servicenow-houston','B12 Consulting','ServiceNow Platform Administrator (12-mo contract, W2)','Houston, TX (on-site)','https://www.dice.com/job-detail/a7178183-e042-4084-b058-2fa4983a92a5','ServiceNow','Not listed','40','Stretch','Local and on-site. Emphasizes documentation, requirements gathering, process mapping, and UAT, which match your process-engineering work.',array['Contract role that wants update sets, upgrades, Flow Designer, and scripting experience. Hands-on platform time is the gap. Treat this as a long shot or a recruiter-relationship play.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'oneimaging-support-ops','OneImaging','Support Operations Specialist II','Remote (US)','https://builtin.com/job/support-operations-specialist-ii/10932776','IT Support','Not listed','68','Good','Remote. Wants Tier 2 escalation, root-cause analysis, knowledge docs, mentoring Tier 1, and ticketing (ServiceNow listed). Those fit your support and instructor history.',array['Wants Google Workspace/M365 admin and MDM/endpoint management. Add either one only if you''ve actually done it.']::text[],'2026-09-29'),
((select id from public.sources where kind='manual'),'aoi-linux-sugar-land','Applied Optoelectronics (AOI)','Linux & Proxmox Systems Administrator','Sugar Land, TX (on-site)','https://www.dice.com/job-detail/ce3124d5-b15d-410c-a4a2-c531848f15a9','Sysadmin','Not listed','40','Stretch','Minutes from Mission Bend. The company makes optical transceivers for data centers, so your AI-rack background is relevant.',array['Python helps, but it still requires 3+ yrs professional Linux admin, Proxmox/Ceph/ZFS, Bash, and monitoring tools. That''s a big gap. Consider asking whether they have a junior or hardware role instead.']::text[],'2026-09-29');

insert into public.applications (posting_id, status, resume_folder)
select p.id, 'Saved', 'job-hunt/' || p.external_id from public.postings p join public.sources s on s.id = p.source_id where s.kind = 'manual';
