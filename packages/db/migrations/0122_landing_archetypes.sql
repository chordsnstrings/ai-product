-- 0122 · One landing page per ad archetype (plan 04 L1: texture demo, serum launch, UGC, creative fatigue, founder;
-- standard §5 "skincare UGC, texture demonstration, serum launch or creative-fatigue replacement"). 0006 seeded the
-- default, texture and fatigue pages; these add the other three, live, routed by utm_content prefix. Each page's
-- hero shows the built-in example of its own archetype until staff pick one in the console (the hero visual is the
-- same archetype as the ad). Copy stays process-level: no product claims.

insert into landing_pages (slug, archetype, status, content, utm_match, published_at, live_content, live_version)
select slug, archetype, 'live', content, utm_match, now(), content, 1
from (values
  ('serum-launch', 'serum_launch', '{
     "label": "Skincare · Launch ads",
     "headline": "Launching a serum? Test the ad before the launch.",
     "sub": "Upload the product. Get three launch angles and a storyboard in about a minute — every line checked against cosmetic claim rules.",
     "proof": "Built only for skincare brands"
   }'::jsonb, '{serum,launch}'::text[]),
  ('ugc', 'ugc', '{
     "label": "Skincare · Creator-style ads",
     "headline": "Creator-style skincare ads, without chasing creators.",
     "sub": "Routine and first-person formats for your product, planned from what your customers say — never fake testimonials.",
     "proof": "Built only for skincare brands"
   }'::jsonb, '{ugc,creator}'::text[]),
  ('founder', 'founder', '{
     "label": "Skincare · Founder-story ads",
     "headline": "Tell why you made it. We’ll turn it into a tested ad.",
     "sub": "Founder-story ads built around your real product and your own words, checked for claims before you see them.",
     "proof": "Built only for skincare brands"
   }'::jsonb, '{founder}'::text[])
) as v(slug, archetype, content, utm_match)
on conflict (slug) do nothing;
