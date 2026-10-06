import { HomePage } from "@/components/home/HomePage";
import { Toaster } from "@/components/ui/Toast";
import { ConfirmHost } from "@/components/ui/Confirm";

export default function Home() {
  return (
    <>
      <HomePage />
      <Toaster />
      <ConfirmHost />
    </>
  );
}
