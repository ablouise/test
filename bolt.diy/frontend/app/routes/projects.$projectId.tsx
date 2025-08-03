import { json, type LoaderFunctionArgs, type MetaFunction } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  return [
    { title: `Bolt - ${data?.projectId}` },
    { name: 'description', content: `Project ${data?.projectId}` }
  ];
};

export async function loader({ params }: LoaderFunctionArgs) {
  const { projectId } = params;
  
  if (!projectId) {
    throw new Response("Project not found", { 
      status: 404,
      statusText: "Not Found" 
    });
  }

  return json({ projectId });
}

export default function ProjectPage() {
  const { projectId } = useLoaderData<typeof loader>();
  
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <ClientOnly fallback={<BaseChat />}>
        {() => <Chat projectId={projectId} />}
      </ClientOnly>
    </div>
  );
}
