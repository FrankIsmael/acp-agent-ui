import { demoStatus, demoUser } from "~/.server/demo";
export function loader({ request }: { request: Request }) {
  const id = demoUser(request);
  return Response.json(id ? demoStatus(id) : { enabled: false }, { headers: { "Cache-Control": "private, no-store" } });
}
