import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold text-[var(--renderify-accent)]">
        404
      </p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight">Page not found</h1>
      <p className="mt-4 text-fd-muted-foreground">
        The requested Renderify page does not exist or has moved.
      </p>
      <Link
        className="mt-7 font-semibold underline underline-offset-4"
        href="/"
      >
        Return home
      </Link>
    </main>
  );
}
