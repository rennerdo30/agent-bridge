using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// GET_VIRTUAL_DISK_INFO_IDENTIFIER is the actual VHD GUID, independent of its path.
public static class CiWindowsVhd
{
    [StructLayout(LayoutKind.Sequential)]
    struct StorageType { public uint DeviceId; public Guid VendorId; }
    [StructLayout(LayoutKind.Sequential)]
    struct OpenParameters { public uint Version; public uint ReadWriteDepth; }
    // The native union includes ULONGLONG fields and therefore starts at offset 8.
    [StructLayout(LayoutKind.Explicit, Size = 32)]
    struct DiskInfo {
        [FieldOffset(0)] public uint Version;
        [FieldOffset(8)] public Guid Identifier;
    }
    [DllImport("virtdisk.dll", CharSet = CharSet.Unicode)]
    static extern uint OpenVirtualDisk(ref StorageType type, string path, uint access,
        uint flags, ref OpenParameters parameters, out SafeFileHandle handle);
    [DllImport("virtdisk.dll")]
    static extern uint GetVirtualDiskInformation(SafeFileHandle handle, ref uint size,
        ref DiskInfo info, out uint used);
    [DllImport("virtdisk.dll")]
    static extern uint DetachVirtualDisk(SafeFileHandle handle, uint flags, uint providerFlags);

    static SafeFileHandle Open(string path, bool detach) {
        var type = new StorageType { DeviceId = 3, VendorId = new Guid("ec984aec-a0f9-47e9-901f-71415a66345b") };
        var parameters = new OpenParameters { Version = 1, ReadWriteDepth = 1 };
        SafeFileHandle handle;
        // GET_INFO plus DETACH for permanently attached images (OpenVirtualDisk contract).
        uint error = OpenVirtualDisk(ref type, path, detach ? 0x000c0000u : 0x00080000u,
            0, ref parameters, out handle);
        if (error != 0) { if (handle != null) handle.Dispose(); throw new Win32Exception((int)error); }
        return handle;
    }
    static Guid Read(SafeFileHandle handle) {
        var info = new DiskInfo { Version = 2 };
        uint size = 32, used;
        uint error = GetVirtualDiskInformation(handle, ref size, ref info, out used);
        if (error != 0) throw new Win32Exception((int)error);
        if (info.Identifier == Guid.Empty) throw new InvalidOperationException("Empty VHD GUID");
        return info.Identifier;
    }
    public static Guid ReadGuid(string path) {
        // The image may already be permanently attached; DETACH access permits opening it.
        using (var handle = Open(path, true)) return Read(handle);
    }
    public static void Detach(string path, Guid expected) {
        using (var handle = Open(path, true)) {
            if (expected == Guid.Empty || Read(handle) != expected)
                throw new InvalidOperationException("VHD GUID changed; refusing detach");
            uint error = DetachVirtualDisk(handle, 0, 0);
            if (error != 0) throw new Win32Exception((int)error);
        }
    }
}
