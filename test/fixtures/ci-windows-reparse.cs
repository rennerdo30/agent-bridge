using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Test-only mutation of a directory created by the guard fixture, never user data.
public static class CiReparseFixture
{
    [StructLayout(LayoutKind.Sequential)]
    struct AttributeTag { public uint Attributes, Tag; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input,
        uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        out AttributeTag info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLink(string path, string existing, IntPtr security);
    public static int TryCreateHardLink(string path, string existing) {
        return CreateHardLink(path, existing, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error();
    }
    public static uint ReadFileAttributes(string path) {
        // Query the actual object, not a hard link's potentially stale directory entry.
        using (var handle = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            AttributeTag info;
            if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & 0x410) != 0) throw new IOException("Fixture attribute probe requires a physical regular file");
            return info.Attributes;
        }
    }
    public static SafeFileHandle HoldWriteDirectory(string path) {
        var handle = CreateFile(path, 0x40000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error);
        }
        return handle;
    }
    public static int ConvertToJunction(string path, string target) {
        return ConvertToJunctionRaw(path, Path.GetFullPath(target));
    }
    public static int ConvertToJunctionRaw(string path, string target) {
        using (var handle = CreateFile(path, 0x40000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (handle.IsInvalid) return Marshal.GetLastWin32Error();
            string substitute = "\\??\\" + target;
            byte[] sub = Encoding.Unicode.GetBytes(substitute), print = Encoding.Unicode.GetBytes(target);
            byte[] data;
            using (var buffer = new MemoryStream()) {
                using (var writer = new BinaryWriter(buffer, Encoding.Unicode, true)) {
                    writer.Write(0xA0000003u);
                    writer.Write((ushort)(8 + sub.Length + 2 + print.Length + 2));
                    writer.Write((ushort)0);
                    writer.Write((ushort)0); writer.Write((ushort)sub.Length);
                    writer.Write((ushort)(sub.Length + 2)); writer.Write((ushort)print.Length);
                    writer.Write(sub); writer.Write((ushort)0);
                    writer.Write(print); writer.Write((ushort)0);
                }
                data = buffer.ToArray();
            }
            uint returned;
            return DeviceIoControl(handle, 0x000900a4, data, (uint)data.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero)
                ? 0 : Marshal.GetLastWin32Error();
        }
    }
}
