-- path: migrations/0065_blog_posts.down.sql
-- STEP 032 - the rollback of the blog posts table: the guard function and the table, in one
-- transaction.

begin;

drop table if exists public.blog_posts;

drop function if exists public.blog_posts_guard_state();

commit;
