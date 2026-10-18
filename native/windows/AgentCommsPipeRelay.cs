using System;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;
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

    private static void Main(string[] args) {
        // A disconnected parent must never open a GUI exception dialog.
        try {
            if (args.Length != 0) {
                // Fixed custody operations share the verified, console-free
                // package helper. Arguments never contain paths or accounts.
                Environment.ExitCode = 1;
                StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), false);
                StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                if (args.Length != 1) return;
                if (args[0] == "--sid") {
                    string account = input.ReadToEnd();
                    if (account.Length == 0 || account.Length > 1024 || account.IndexOfAny(new char[] {'\r','\n','\0'}) >= 0) return;
                    output.Write(new NTAccount(account).Translate(typeof(SecurityIdentifier)).Value);
                } else if (args[0] == "--inspect") {
                    string file;
                    int count = 0;
                    while ((file = input.ReadLine()) != null) {
                        if (++count > 128 || file.Length > 32767 || file.IndexOf('\0') >= 0) return;
                        try {
                            FileAttributes attributes = File.GetAttributes(file);
                            bool directory = (attributes & FileAttributes.Directory) != 0;
                            FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(file) : File.GetAccessControl(file);
                            string owner = security.GetOwner(typeof(SecurityIdentifier)).Value;
                            output.WriteLine(owner + "|" + (directory ? "directory" : "file") + "|" +
                                ((attributes & FileAttributes.ReparsePoint) != 0 ? "link" : "real"));
                        } catch { output.WriteLine("missing"); }
                    }
                    if (count == 0) return;
                } else return;
                output.Flush();
                Environment.ExitCode = 0;
                return;
            }
            Run();
        } catch { }
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
