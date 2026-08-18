import Link from "next/link";
import { logout } from "./actions";

export function ConsoleNav({ managerName }: { managerName: string }) {
  return (
    <nav className="nav">
      <Link href="/dashboard" className="wordmark">
        ATELIER
      </Link>
      <div className="nav-right">
        <Link href="/dashboard">Households</Link>
        <Link href="/models">Models</Link>
        <span>{managerName}</span>
        <form action={logout}>
          <button className="link-btn" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
