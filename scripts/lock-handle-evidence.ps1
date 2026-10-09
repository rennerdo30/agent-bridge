param([Parameter(Mandatory=$true)][string]$LockPath)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LockHandleEvidence {
 [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Info {
  public UniqueProcess process;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string app;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string service;
  public uint type,status,session;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
 }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session,int flags,System.Text.StringBuilder key);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session,uint files,string[] paths,uint processes,UniqueProcess[] ids,uint services,string[] names);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session,out uint needed,ref uint count,[In,Out] Info[] infos,ref uint reasons);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
 public static uint[] Holders(string path) {
  uint session;int code=RmStartSession(out session,0,new System.Text.StringBuilder(33));if(code!=0)throw new Exception("Restart Manager start: "+code);
  try {
   code=RmRegisterResources(session,1,new[]{path},0,null,0,null);if(code!=0)throw new Exception("Restart Manager resource: "+code);
   uint needed,count=0,reasons=0;code=RmGetList(session,out needed,ref count,null,ref reasons);
   if(code==0)return new uint[0];if(code!=234)throw new Exception("Restart Manager list: "+code);
   for(int attempt=0;attempt<3;attempt++) {count=needed;var info=new Info[count];code=RmGetList(session,out needed,ref count,info,ref reasons);if(code==234)continue;if(code!=0)throw new Exception("Restart Manager list: "+code);var pids=new uint[count];for(int i=0;i<count;i++)pids[i]=info[i].process.pid;return pids;}
   throw new Exception("Open handles changed during evidence collection");
  }finally{RmEndSession(session);}
 }
}
'@
@([LockHandleEvidence]::Holders($LockPath)) | ConvertTo-Json -Compress
