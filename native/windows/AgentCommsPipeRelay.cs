using System;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Threading;

// Built as /target:winexe: inherited binary stdio, no console host or UI.
internal static class AgentCommsPipeRelay {
    private static void Copy(Stream source, Stream destination) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) != 0) {
            destination.Write(buffer, 0, count);
            destination.Flush();
        }
    }

    private static void Main() {
        // A disconnected parent must never open a GUI exception dialog.
        try { Run(); } catch { }
    }

    private static void Run() {
        NamedPipeClientStream pipe = null;
        try {
            string name = Environment.GetEnvironmentVariable("AGENT_COMMS_PIPE_NAME");
            if (String.IsNullOrEmpty(name)) throw new ArgumentException();
            pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut,
                PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
            pipe.Connect(10000);
        } catch {
            Console.Error.Write("REFUSED\n");
            Console.Error.Flush();
            if (pipe != null) pipe.Dispose();
            return;
        }

        Console.Error.Write("CONNECTED\n");
        Console.Error.Flush();
        Thread input = new Thread(() => {
            try { Copy(Console.OpenStandardInput(), pipe); }
            catch { }
            finally { try { pipe.Dispose(); } catch { } }
        });
        input.IsBackground = true;
        input.Start();
        try { Copy(pipe, Console.OpenStandardOutput()); }
        catch { }
        finally { try { pipe.Dispose(); } catch { } }
    }
}
