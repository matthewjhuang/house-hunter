-- New place kinds: Work, Gym, Shops, Health (doctors, dentist, hospital),
-- Family + Friends, General. Study goes; General replaces Other.

create type public.place_kind_v2 as enum ('work', 'gym', 'shops', 'health', 'family', 'general');

alter table public.places alter column kind drop default;
alter table public.places alter column kind type public.place_kind_v2 using (
  case kind::text when 'study' then 'general' when 'other' then 'general' else kind::text end
)::public.place_kind_v2;
alter table public.places alter column kind set default 'general';

drop type public.place_kind;
alter type public.place_kind_v2 rename to place_kind;
