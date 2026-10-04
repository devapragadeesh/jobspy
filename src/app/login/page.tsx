import { LoginForm } from "@/components/forms";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xs flex-col justify-center px-4">
      <h1 className="mb-6 text-lg font-semibold tracking-tight">jobspy</h1>
      <LoginForm />
    </main>
  );
}
