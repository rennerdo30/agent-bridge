using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Pin identities without FILE_SHARE_DELETE. Tree directories and the marker also
// deny write sharing; ordinary files/ancestors permit compatible existing writers.
// Deletion uses the verified handles, including for the marker and root itself.
public static class CiWindowsCleanup
{
    [StructLayout(LayoutKind.Sequential)]
    struct AttributeTag { public uint Attributes; public uint Tag; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInfo {
        public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
        public uint Attributes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
    sealed class Entry {
        public string Path;
        public SafeFileHandle Handle;
        public uint Attributes;
        public Entry Target;
        public string Substitute;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        out AttributeTag info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass,
        ref Disposition info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass,
        ref BasicInfo info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileSizeEx(SafeFileHandle handle, out long size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint count,
        out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path,
        uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input,
        uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlapped);

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static SafeFileHandle Acquire(string path, uint access, uint share) {
        var handle = CreateFile(path, access, share, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error(); handle.Dispose();
            throw new IOException("Cleanup open refused: " + path + "; win32=" + error, new Win32Exception(error));
        }
        return handle;
    }
    static Entry Open(string path, bool deleting, bool marker, bool allowJunction = false) {
        // OPEN_REPARSE_POINT inspects the entry itself; BACKUP_SEMANTICS permits dirs.
        // READ_DATA / LIST_DIRECTORY makes ancestor handles participate in sharing
        // enforcement; attribute-only opens are exempt from those rules.
        AttributeTag initial;
        using (var metadata = Acquire(path, 0x80, 7))
            Check(GetFileInformationByHandleEx(metadata, 9, out initial, 8));
        bool directory = (initial.Attributes & 0x10) != 0;
        uint access = 0x81u | (deleting ? 0x10100u : 0u) | (marker ? 0x80000000u : 0u);
        uint share = marker || (deleting && directory) ? 1u : 3u;
        var handle = Acquire(path, access, share);
        try {
            AttributeTag info;
            Check(GetFileInformationByHandleEx(handle, 9, out info, 8));
            if (((info.Attributes & 0x10) != 0) != directory) throw new IOException("Cleanup entry type changed: " + path);
            if ((info.Attributes & 0x400) != 0 && (!allowJunction || marker || info.Tag != 0xA0000003u))
                throw new IOException("Refusing reparse point: " + path);
            return new Entry { Path = path, Handle = handle, Attributes = info.Attributes };
        } catch { handle.Dispose(); throw; }
    }
    static string FinalPath(SafeFileHandle handle) {
        var path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= path.Capacity) throw new IOException("Canonical cleanup path too long");
        return path.ToString().TrimEnd('\\');
    }
    static void VerifyPath(Entry entry, string expected) {
        if (!string.Equals(FinalPath(entry.Handle), expected, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Cleanup handle escaped its physical parent");
    }
    static void Collect(string path, string canonical, string marker, List<Entry> entries, Action<string> beforeEnumerate, Action<string> beforeOpen) {
        if (beforeOpen != null) beforeOpen(path);
        Entry entry;
        try { entry = Open(path, true, string.Equals(path, marker, StringComparison.OrdinalIgnoreCase), entries.Count != 0); }
        catch (IOException error) {
            var native = error.InnerException as Win32Exception;
            // Enumeration is a snapshot. Nothing can be deleted through a missing
            // child. Root/marker/target proofs are still mandatory below.
            if (entries.Count != 0 && native != null && (native.NativeErrorCode == 2 || native.NativeErrorCode == 3)) return;
            throw;
        }
        entries.Add(entry);
        VerifyPath(entry, canonical);
        if ((entry.Attributes & 0x400) != 0) return; // Never enumerate a junction's target.
        if ((entry.Attributes & 0x10) != 0) {
            if (beforeEnumerate != null) beforeEnumerate(path);
            foreach (string child in Directory.EnumerateFileSystemEntries(path))
                Collect(child, canonical + "\\" + Path.GetFileName(child), marker, entries, beforeEnumerate, beforeOpen);
        }
    }
    static string JunctionSubstitute(Entry entry) {
        byte[] buffer = new byte[16384];
        uint returned;
        Check(DeviceIoControl(entry.Handle, 0x000900a8, IntPtr.Zero, 0, buffer, (uint)buffer.Length, out returned, IntPtr.Zero));
        if (returned < 16 || BitConverter.ToUInt32(buffer, 0) != 0xA0000003u)
            throw new IOException("Unknown junction target");
        int offset = BitConverter.ToUInt16(buffer, 8), length = BitConverter.ToUInt16(buffer, 10);
        if ((offset & 1) != 0 || (length & 1) != 0 || 16 + offset + length > returned)
            throw new IOException("Unreadable junction target");
        string substitute = Encoding.Unicode.GetString(buffer, 16 + offset, length);
        // Volume mount points, UNC targets and relative targets are never admitted.
        if (substitute.Length < 7 || !substitute.StartsWith("\\??\\", StringComparison.Ordinal) ||
            !char.IsLetter(substitute[4]) || substitute[5] != ':' || substitute[6] != '\\')
            throw new IOException("Refusing mount point or nonabsolute junction target");
        foreach (string component in substitute.Substring(7).Split('\\'))
            if (component == "." || component == "..") throw new IOException("Refusing noncanonical junction target");
        return "\\\\?\\" + Path.GetFullPath(substitute.Substring(4)).TrimEnd('\\');
    }
    static void VerifyJunctions(List<Entry> entries, string rootCanonical, bool recheck) {
        foreach (var link in entries) {
            if ((link.Attributes & 0x400) == 0) continue;
            string observed = "unknown/unproven";
            try {
                string substitute = JunctionSubstitute(link);
                observed = substitute;
                if (!substitute.StartsWith(rootCanonical + "\\", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Junction target escaped its marked root");
                // Only entries from the ordinary physical walk can be a target. A chain,
                // alias ancestor, missing path or unreadable target cannot enter this set.
                var target = entries.Find(e => string.Equals(FinalPath(e.Handle), substitute, StringComparison.OrdinalIgnoreCase));
                if (target == null || (target.Attributes & 0x10) == 0 || (target.Attributes & 0x400) != 0)
                    throw new IOException("Junction target is not a physical directory in its marked root");
                AttributeTag current;
                Check(GetFileInformationByHandleEx(target.Handle, 9, out current, 8));
                if ((current.Attributes & 0x400) != 0) throw new IOException("Junction target changed into a reparse point");
                if (recheck && (target != link.Target || !string.Equals(substitute, link.Substitute, StringComparison.OrdinalIgnoreCase)))
                    throw new IOException("Junction target changed before deletion");
                link.Target = target; link.Substitute = substitute;
            } catch (Exception error) {
                throw new IOException("Cleanup retained root: junction " + link.Path + " -> " +
                    observed + "; reason=" + error.Message, error);
            }
        }
    }
    static void VerifyMarker(Entry marker, string contents) {
        if ((marker.Attributes & 0x10) != 0) throw new IOException("Marker is a directory");
        byte[] expected = Encoding.UTF8.GetBytes(contents);
        long size;
        Check(GetFileSizeEx(marker.Handle, out size));
        if (size != expected.Length) throw new IOException("Cleanup marker missing or changed");
        byte[] actual = new byte[expected.Length];
        uint read;
        Check(ReadFile(marker.Handle, actual, (uint)actual.Length, out read, IntPtr.Zero));
        if (read != actual.Length) throw new IOException("Incomplete cleanup marker");
        for (int i = 0; i < expected.Length; i++)
            if (actual[i] != expected[i]) throw new IOException("Cleanup marker changed");
    }
    public static void Remove(string root, string markerName, string contents) {
        Remove(root, markerName, contents, null);
    }
    // Callback lets the regression attempt replacement after all handles are pinned.
    public static void Remove(string root, string markerName, string contents, Action beforeDelete) {
        Remove(root, markerName, contents, beforeDelete, null);
    }
    public static void Remove(string root, string markerName, string contents, Action beforeDelete, Action<string> beforeEnumerate) {
        Remove(root, markerName, contents, beforeDelete, beforeEnumerate, null);
    }
    public static void Remove(string root, string markerName, string contents, Action beforeDelete, Action<string> beforeEnumerate, Action<string> afterUnlink) {
        Remove(root, markerName, contents, beforeDelete, beforeEnumerate, afterUnlink, null);
    }
    public static void Remove(string root, string markerName, string contents, Action beforeDelete, Action<string> beforeEnumerate, Action<string> afterUnlink, Action<string> beforeOpen) {
        root = Path.GetFullPath(root).TrimEnd('\\');
        string markerPath = Path.Combine(root, markerName);
        var ancestors = new List<Entry>();
        var entries = new List<Entry>();
        try {
            string drive = Path.GetPathRoot(root), path = drive;
            var ancestor = Open(drive, false, false);
            ancestors.Add(ancestor);
            string canonical = FinalPath(ancestor.Handle);
            string[] parts = root.Substring(drive.Length).Split('\\');
            for (int i = 0; i < parts.Length - 1; i++) {
                path = Path.Combine(path, parts[i]);
                ancestor = Open(path, false, false);
                ancestors.Add(ancestor);
                canonical += "\\" + parts[i];
                VerifyPath(ancestor, canonical);
            }
            string rootCanonical = canonical + "\\" + parts[parts.Length - 1];
            Collect(root, rootCanonical, markerPath, entries, beforeEnumerate, beforeOpen);
            var marker = entries.Find(e => string.Equals(e.Path, markerPath, StringComparison.OrdinalIgnoreCase));
            if (marker == null) throw new IOException("Cleanup marker missing");
            VerifyMarker(marker, contents);
            VerifyJunctions(entries, rootCanonical, false);
            if (beforeDelete != null) beforeDelete();
            VerifyJunctions(entries, rootCanonical, true);
            // All guards finish before any deletion. Unlink admitted junctions first;
            // targets remain pinned and are removed only by the normal physical walk.
            foreach (var link in entries) {
                if ((link.Attributes & 0x400) == 0) continue;
                Delete(link);
                Console.WriteLine("Cleanup: unlinked " + link.Path + " -> " + link.Substitute +
                    "; reason=physical directory inside this invocation's marked root; no target traversal");
                if (afterUnlink != null) afterUnlink(link.Path);
            }
            // Bottom-up disposal completes each child deletion before its parent.
            // The marker stays pinned until every other child has been removed.
            for (int i = entries.Count - 1; i >= 0; i--) {
                var entry = entries[i];
                if (entry == marker || i == 0 || (entry.Attributes & 0x400) != 0) continue;
                Delete(entry);
            }
            Delete(marker);
            Delete(entries[0]);
        } finally {
            foreach (var entry in entries) entry.Handle.Dispose();
            for (int i = ancestors.Count - 1; i >= 0; i--) ancestors[i].Handle.Dispose();
        }
    }
    static void Delete(Entry entry) {
        if ((entry.Attributes & 1) != 0) {
            uint attributes = entry.Attributes & ~1u;
            var basic = new BasicInfo { Attributes = attributes == 0 ? 0x80u : attributes };
            Check(SetFileInformationByHandle(entry.Handle, 0, ref basic, (uint)Marshal.SizeOf(typeof(BasicInfo))));
        }
        var disposition = new Disposition { Delete = true };
        Check(SetFileInformationByHandle(entry.Handle, 4, ref disposition, 4));
        entry.Handle.Dispose();
    }
}
