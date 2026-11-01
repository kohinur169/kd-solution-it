-- path: migrations/0065_blog_posts.sql
-- STEP 032 - the blog posts of section 25: one row per article the blogger writes.
--
-- Section 25 keeps the blogger role and the CMS from the first day of launch, and asks for posts
-- that can be created, edited and published. A post is its own table rather than a row of
-- `cms_pages`, because it has an author, an excerpt and a cover image, and because it has a third
-- state: an article that was published and later retired is `archived` with the instant it
-- happened, which a public page never needs.
--
-- The status walks `draft` to `published` to `archived` and never back, and each instant is
-- written once. `blog_posts_guard_state` freezes the slug and the author, so a link cannot be
-- repointed at another article and an article cannot be reassigned to another writer, and it
-- refuses a delete of a post that was ever published, because a published url is a link that
-- lives outside the platform.
--
-- The cover image is a `files` row of the `cms_image` purpose, the vocabulary that `0058` added;
-- the SEO pair is stored beside the body for the metadata generator of STEP 237.

begin;

create function public.blog_posts_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.slug is distinct from old.slug
       or new.author_id is distinct from old.author_id then
      raise exception 'a post keeps its slug and its author'
        using errcode = 'check_violation';
    end if;

    if old.published_at is not null
       and new.published_at is distinct from old.published_at then
      raise exception 'a post publication instant is recorded once'
        using errcode = 'check_violation';
    end if;

    if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
      raise exception 'a post archive instant is recorded once'
        using errcode = 'check_violation';
    end if;

    if old.status is distinct from new.status and not (
      (old.status = 'draft' and new.status = 'published')
      or (old.status = 'published' and new.status = 'archived')
    ) then
      raise exception 'a post walks from draft to published to archived, and never back'
        using errcode = 'check_violation';
    end if;

    if old.published_at is not null and new.deleted_at is not null then
      raise exception 'a published post is archived, never deleted'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.blog_posts_guard_state() is
  'Keeps a post on its slug and its author, writes its instants once and walks its status.';

create table public.blog_posts (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  slug text not null,
  title text not null,
  excerpt text,
  body text not null,
  cover_file_id uuid,
  status text not null default 'draft',
  author_id uuid not null,
  seo_title text,
  seo_description text,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint blog_posts_pkey primary key (id),
  constraint blog_posts_company_fkey foreign key (company_id) references public.companies (id),
  constraint blog_posts_cover_fkey foreign key (cover_file_id) references public.files (id),
  constraint blog_posts_author_fkey foreign key (author_id) references public.users (id),
  constraint blog_posts_platform_check check (company_id is null),
  constraint blog_posts_slug_check check (
    char_length(slug) between 1 and 120
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint blog_posts_title_check check (
    char_length(title) between 1 and 160
    and title = btrim(title)
  ),
  constraint blog_posts_excerpt_check check (
    excerpt is null
    or (
      char_length(excerpt) between 1 and 320
      and excerpt = btrim(excerpt)
    )
  ),
  constraint blog_posts_body_check check (char_length(body) between 1 and 200000),
  constraint blog_posts_status_check check (status in ('draft', 'published', 'archived')),
  constraint blog_posts_published_check check (
    (status <> 'draft') = (published_at is not null)
  ),
  constraint blog_posts_archived_check check (
    (status = 'archived') = (archived_at is not null)
  ),
  constraint blog_posts_seo_title_check check (
    seo_title is null
    or (
      char_length(seo_title) between 1 and 70
      and seo_title = btrim(seo_title)
    )
  ),
  constraint blog_posts_seo_description_check check (
    seo_description is null
    or (
      char_length(seo_description) between 1 and 320
      and seo_description = btrim(seo_description)
    )
  ),
  constraint blog_posts_updated_check check (updated_at >= created_at),
  constraint blog_posts_deleted_check check (deleted_at is null or deleted_at >= created_at),
  constraint blog_posts_row_version_check check (version > 0)
);

comment on table public.blog_posts is
  'One blog post of section 25, with its author, its cover image and its archive state.';

comment on column public.blog_posts.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.blog_posts.company_id is
  'Always null: the blog belongs to the platform, not to a merchant.';

comment on column public.blog_posts.slug is
  'The article url, lower case with single hyphens, unique among live posts.';

comment on column public.blog_posts.title is
  'The headline, 1 to 160 characters, stored trimmed.';

comment on column public.blog_posts.excerpt is
  'The summary the listing page shows, up to 320 characters.';

comment on column public.blog_posts.body is
  'The article content an editor saves, up to 200000 characters.';

comment on column public.blog_posts.cover_file_id is
  'The cover image, a files row of the cms_image purpose.';

comment on column public.blog_posts.status is
  'draft, published or archived; the guard walks it forward only.';

comment on column public.blog_posts.author_id is
  'The blogger who wrote it. Frozen, because an article has one author.';

comment on column public.blog_posts.seo_title is
  'The title the metadata generator of STEP 237 uses, up to 70 characters.';

comment on column public.blog_posts.seo_description is
  'The description that generator uses, up to 320 characters.';

comment on column public.blog_posts.published_at is
  'When the post went live. Written once and required by published and archived.';

comment on column public.blog_posts.archived_at is
  'When the post was retired. Written once and required by the archived state.';

comment on column public.blog_posts.created_at is
  'When the row was written.';

comment on column public.blog_posts.updated_at is
  'Set by the blog_posts_set_row_metadata trigger on every update.';

comment on column public.blog_posts.deleted_at is
  'Soft delete marker; the guard refuses it once the post was published.';

comment on column public.blog_posts.version is
  'Optimistic locking counter, incremented by the blog_posts_set_row_metadata trigger.';

-- One live post per url, so the sitemap of STEP 237 never lists the same article twice.
create unique index blog_posts_slug_key
  on public.blog_posts (slug)
  where deleted_at is null;

-- The public listing: published posts, newest first.
create index blog_posts_published_idx
  on public.blog_posts (status, published_at desc)
  where deleted_at is null;

-- The blogger's own list of what they wrote.
create index blog_posts_author_idx
  on public.blog_posts (author_id, created_at desc)
  where deleted_at is null;

create trigger blog_posts_guard_state
  before insert or update on public.blog_posts
  for each row
  execute function public.blog_posts_guard_state();

create trigger blog_posts_set_row_metadata
  before update on public.blog_posts
  for each row
  execute function public.set_row_metadata();

alter table public.blog_posts enable row level security;

create policy blog_posts_default_deny
  on public.blog_posts
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
