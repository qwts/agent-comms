$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Threading;

public static class AgentCommsPipeClient {
    static void Copy(Stream source, Stream destination) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) != 0) {
            destination.Write(buffer, 0, count);
            destination.Flush();
        }
    }

    public static void Run(string name) {
        NamedPipeClientStream pipe = null;
        try {
            // The relay reads and writes this duplex handle concurrently.
            pipe = new NamedPipeClientStream(
                ".", name, PipeDirection.InOut, PipeOptions.Asynchronous,
                TokenImpersonationLevel.Identification);
            pipe.Connect(10000);
        } catch {
            Console.Error.Write("REFUSED\n");
            Console.Error.Flush();
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
'@
[void](Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Core.dll'))
[AgentCommsPipeClient]::Run($env:AGENT_COMMS_PIPE_NAME)
