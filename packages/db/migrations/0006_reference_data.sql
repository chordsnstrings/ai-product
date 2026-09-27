-- 0006 · Reference data from the standard (§5, §6, Appendix A). Staff change these later via admin (four-eyes).

insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, source_url, notes, status) values
  ('anthropic', 'claude-opus-5-5', 1, 'per_million_tokens',
   '{"input": 4000000, "output": 20000000, "cache_read": 200000}', '2026-09-23', 'https://www.anthropic.com/claude-opus-5-5',
   'Standard §6 [R17]. Values in micros per million tokens.', 'published'),
  ('byteplus', 'seedream-5-0-pro', 1, 'per_image',
   '{"image": 45000}', '2026-09-23', 'https://ai.byteplus.com/en/product/Seedream', 'Standard §6 [R16].', 'published'),
  ('byteplus', 'dreamina-seedance-2-5', 1, 'per_second',
   '{"per_second_720p": 231333, "per_second_1080p": 520500, "per_million_tokens": 10700000, "per_million_tokens_video_input": 6400000}',
   '2026-09-23', 'https://ai.byteplus.com/en',
   'Standard §6 [R14]: $3.47 per standard 15s 720p. 1080p multiplier 2.25x is a planning assumption.', 'published'),
  ('minimax', 'speech-2.8-hd', 1, 'per_million_chars', '{"char_million": 100000000}', '2026-09-23',
   'https://platform.minimax.io/docs/guides/pricing-paygo', 'Pay-as-you-go.', 'published'),
  ('minimax', 'speech-2.8-turbo', 1, 'per_million_chars', '{"char_million": 60000000}', '2026-09-23',
   'https://platform.minimax.io/docs/guides/pricing-paygo', 'Pay-as-you-go.', 'published'),
  ('byteplus', 'seed-speech-2-0', 1, 'per_million_chars', '{"char_million": 30000000}', '2026-09-23',
   'https://docs.byteplus.com/en/docs/byteplusvoice/TTS_Billing', 'Pay-as-you-go; SSML/whitespace billed.', 'published'),
  ('internal', 'media-pipeline', 1, 'per_output', '{"transcode_storage_delivery": 150000, "buffer": 150000}', '2026-09-23',
   null, 'Standard §6 planning allowances.', 'published');

insert into model_routes (task, provider, model, prompt_version) values
  ('extract.product_facts', 'anthropic', 'claude-opus-5-5', 'extract-product@1.0.0'),
  ('extract.claims', 'anthropic', 'claude-opus-5-5', 'extract-claims@1.0.0'),
  ('vision.fingerprint', 'anthropic', 'claude-opus-5-5', 'fingerprint@1.0.0'),
  ('creative_director.concepts', 'anthropic', 'claude-opus-5-5', 'concepts@1.0.0'),
  ('creative_director.storyboard', 'anthropic', 'claude-opus-5-5', 'storyboard@1.0.0'),
  ('creative_director.recommendations', 'anthropic', 'claude-opus-5-5', 'recommendations@1.0.0'),
  ('genome.extract', 'anthropic', 'claude-opus-5-5', 'genome@1.0.0'),
  ('customer_language.themes', 'anthropic', 'claude-opus-5-5', 'themes@1.0.0'),
  ('qa.implied_claims', 'anthropic', 'claude-opus-5-5', 'implied-claims@1.0.0'),
  ('qa.fidelity', 'anthropic', 'claude-opus-5-5', 'fidelity@1.0.0'),
  ('image.storyboard_frame', 'byteplus', 'seedream-5-0-pro', 'frame@1.0.0'),
  ('video.scene', 'byteplus', 'dreamina-seedance-2-5', 'scene@1.0.0'),
  ('tts.voiceover', 'minimax', 'speech-2.8-hd', 'voiceover@1.0.0'),
  ('tts.voiceover_fallback', 'byteplus', 'seed-speech-2-0', 'voiceover@1.0.0');

insert into offer_definitions (code, type, price_micros, reference_code, window_minutes, bonus, eligibility) values
  ('TASTE_19', 'TASTE', 19000000, 'STANDALONE_29', 60, '{}', '{"never_purchased": true}'),
  ('STANDALONE_29', 'STANDALONE', 29000000, null, null, '{}', '{}');

insert into taxonomy_versions (version, spec) values (1, '{"source": "Standard Appendix A", "families": ["angle","hook","proof","treatment"]}');

insert into feature_flags (key, description, owner, kind, enabled) values
  ('kill.renders', 'Kill switch: stop dispatching new renders globally', 'ops', 'boolean', false),
  ('kill.free_preview', 'Kill switch: disable free preview analysis', 'ops', 'boolean', false),
  ('kill.checkout', 'Kill switch: disable checkout (maintenance)', 'ops', 'boolean', false),
  ('kill.read_only', 'Kill switch: whole app read-only', 'ops', 'boolean', false),
  ('offer.taste_bonus_hook', 'Bonus alternate hook on Taste offers', 'growth', 'percentage', false);

insert into platform_settings (key, value) values
  ('retention.cancelled_archive_days', '90'),
  ('free_preview.cogs_cap_micros', '200000'),
  ('support.email', '"support@localhost"');

insert into landing_pages (slug, archetype, status, content, utm_match, published_at) values
  ('default', 'general', 'live', '{
     "label": "Skincare · Ad testing",
     "headline": "Know what skincare ad to make next. Then make it.",
     "sub": "Upload your product. Get three test ideas and a storyboard in about a minute. Your first ad is $19.",
     "proof": "Built only for skincare brands"
   }', '{}', now()),
  ('texture', 'texture_demo', 'live', '{
     "label": "Skincare · Texture ads",
     "headline": "Texture-first ads for your serum. Made this week.",
     "sub": "Show the finish, the absorb, the feel. We plan it, check every claim, and produce it.",
     "proof": "Built only for skincare brands"
   }', '{texture}', now()),
  ('fatigue', 'creative_fatigue', 'live', '{
     "label": "Skincare · Creative refresh",
     "headline": "Your best ad is tiring. Here is what to test next.",
     "sub": "Three new directions for your hero product, grounded in what your customers actually say.",
     "proof": "Built only for skincare brands"
   }', '{fatigue,refresh}', now());
