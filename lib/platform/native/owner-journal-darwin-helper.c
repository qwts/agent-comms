/* Disabled broker-owned descriptor bridge. No paths, shell or general fcntl RPC. */
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <libproc.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#if !defined(__APPLE__) || !defined(F_ALLOCATEPERSIST)
#error This helper requires reviewed Darwin persistent-allocation primitives.
#endif
static const char *names[11] = {"acceptance.record", "original-action.record", "prepared-challenge.record",
  "presence.record", "receipt.record", "authorization.record", "release.record", "initial-outcome.record",
  "observation-reference.record", "terminal-reference.record", "scratch.record"};
static const size_t sizes[11] = {4352,33024,33024,4352,4352,4352,4352,4352,2304,2304,33024};
/* Status 0 ready, 1 completed, 2 refused. Stages are fixed diagnostic numbers. */
static void reply(unsigned status, unsigned stage, unsigned slot, int code) {
  unsigned char bytes[32] = {0}; memcpy(bytes,"ODJNRES1",8);
  bytes[8]=(unsigned char)status; bytes[9]=(unsigned char)stage; bytes[10]=(unsigned char)slot;
  uint32_t value=(uint32_t)code; for(unsigned i=0;i<4;i++)bytes[12+i]=(unsigned char)(value>>(24-8*i));
  size_t done=0; while(done<sizeof bytes) { ssize_t n=write(STDOUT_FILENO,bytes+done,sizeof bytes-done);
    if(n<0&&errno==EINTR)continue; if(n<=0)_exit(74); done+=(size_t)n; }
}
static void refuse(unsigned stage,unsigned slot,int code) { reply(2,stage,slot,code); _exit(1); }
static void read_all(void *buffer,size_t length) {
  size_t done=0; while(done<length) { ssize_t n=read(STDIN_FILENO,(char*)buffer+done,length-done);
    if(n<0&&errno==EINTR)continue; if(n<=0)refuse(9,0,n<0?errno:EPROTO); done+=(size_t)n; }
}
static int same(const struct stat *a,const struct stat *b) {
  return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&a->st_uid==b->st_uid&&a->st_mode==b->st_mode
    &&a->st_nlink==b->st_nlink&&a->st_size==b->st_size;
}
static struct stat checked(int fd,int directory,unsigned slot) {
  struct stat value; if(fstat(fd,&value))refuse(1,slot,errno);
  if(value.st_uid!=geteuid()||(value.st_mode&07777)!=(directory?0700:0600)
    ||(directory?!S_ISDIR(value.st_mode):!S_ISREG(value.st_mode))||(!directory&&value.st_nlink!=1))refuse(8,slot,EINVAL);
  return value;
}
static void named(int directory,const char *name,int fd,int is_directory,unsigned slot) {
  struct stat actual=checked(fd,is_directory,slot), entry;
  if(fstatat(directory,name,&entry,AT_SYMLINK_NOFOLLOW))refuse(8,slot,errno);
  if(!same(&entry,&actual))refuse(8,slot,EINVAL);
}
static pid_t parent;
static void alive(void) { if(getppid()!=parent)refuse(9,0,ECANCELED); }
static void full_flush(int fd,unsigned slot) {
  alive(); if(fcntl(fd,F_FULLFSYNC,0))refuse(5,slot,errno);
}
static unsigned descriptor_list(struct proc_fdinfo *entries,size_t capacity) {
  errno=0; int bytes=proc_pidinfo(getpid(),PROC_PIDLISTFDS,0,entries,(int)(capacity*sizeof *entries));
  if(bytes<=0)refuse(1,0,errno?errno:EIO);
  if((size_t)bytes>=capacity*sizeof *entries||bytes%(int)sizeof *entries)refuse(1,0,EOVERFLOW);
  unsigned count=(unsigned)((size_t)bytes/sizeof *entries);
  for(unsigned i=0;i<count;i++) {
    if(entries[i].proc_fd<0)refuse(1,0,EINVAL);
    for(unsigned j=0;j<i;j++)if(entries[i].proc_fd==entries[j].proc_fd)refuse(1,0,EINVAL);
  }
  return count;
}
static void close_unrelated(unsigned retained) {
  /* Actual FD list, not RLIMIT: valid inherited FDs may exceed a lowered limit.
   * XNU8792 proc_info.c proc_pidfdlist returns bytes copied; saturation refuses.
   * Single-threaded helper performs no asynchronous descriptor creation. */
  struct proc_fdinfo entries[4097]; unsigned count=descriptor_list(entries,4097);
  for(unsigned i=0;i<count;i++)if((unsigned)entries[i].proc_fd>=retained) {
    if(close(entries[i].proc_fd))refuse(1,0,errno);
  }
  count=descriptor_list(entries,4097);
  for(unsigned i=0;i<count;i++)if((unsigned)entries[i].proc_fd>=retained)refuse(1,0,EINVAL);
}
static void validate(const unsigned char *header,int operation,unsigned selected,int fresh) {
  struct stat store=checked(4,1,0), request=checked(5,1,0), lock=checked(3,0,0);
  if(lock.st_size!=0||lock.st_dev!=store.st_dev||request.st_dev!=store.st_dev)refuse(8,0,EINVAL);
  named(4,".journal-lock",3,0,0);
  /* Same inherited open-file description: never LOCK_UN in this process. */
  if(flock(3,LOCK_EX|LOCK_NB))refuse(2,0,errno);
  int requests=openat(4,"requests",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(requests<0)refuse(8,0,errno); struct stat container=checked(requests,1,0);
  named(4,"requests",requests,1,0); if(container.st_dev!=store.st_dev)refuse(8,0,EINVAL);
  char id[37]; memcpy(id,header+16,36); id[36]=0;
  named(requests,id,5,1,0); if(close(requests))refuse(1,0,errno);
  struct statfs filesystem; if(fstatfs(5,&filesystem))refuse(1,0,errno);
  if(strcmp(filesystem.f_fstypename,"apfs"))refuse(8,0,ENOTSUP);
  unsigned first=operation==1?0:selected-1, count=operation==1?11:1;
  for(unsigned n=0;n<count;n++) {
    unsigned index=first+n; int fd=6+(int)n; struct stat value=checked(fd,0,index+1);
    named(5,names[index],fd,0,index+1);
    if(value.st_dev!=store.st_dev||value.st_size!=(off_t)(fresh?0:sizes[index]))refuse(8,index+1,EINVAL);
    int flags=fcntl(fd,F_GETFL); if(flags<0)refuse(1,index+1,errno);
    if((flags&O_ACCMODE)!=O_RDWR||(flags&O_APPEND))refuse(8,index+1,EINVAL);
  }
}
int main(int argc,char **argv) {
  (void)argv; parent=getppid(); if(parent<=1)refuse(9,0,ECANCELED); if(argc!=1)refuse(9,0,EINVAL);
  unsigned char header[64]; read_all(header,sizeof header);
  unsigned operation=header[8],selected=header[9];
  if(memcmp(header,"ODJNAT01",8)||(operation!=1&&operation!=2)
    ||(operation==1?selected!=0:selected<1||selected>11))refuse(9,0,EPROTO);
  for(unsigned n=10;n<16;n++)if(header[n])refuse(9,0,EPROTO);
  for(unsigned n=52;n<64;n++)if(header[n])refuse(9,0,EPROTO);
  for(unsigned n=0;n<36;n++) { unsigned char c=header[16+n];
    if(n==8||n==13||n==18||n==23) { if(c!='-')refuse(9,0,EPROTO); }
    else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))refuse(9,0,EPROTO);
  }
  if(header[30]!='4'||!(header[35]=='8'||header[35]=='9'||header[35]=='a'||header[35]=='b'))refuse(9,0,EPROTO);
  /* Deliberately no inherited arbitrary file capabilities beyond these slots. */
  unsigned descriptors=operation==1?17:7;
  for(unsigned fd=3;fd<descriptors;fd++)if(fcntl((int)fd,F_SETFD,FD_CLOEXEC))refuse(1,0,errno);
  struct rlimit limit; if(getrlimit(RLIMIT_NOFILE,&limit))refuse(1,0,errno);
  /* Node raises its inherited soft limit to 1048575 on current Darwin. */
  if(limit.rlim_cur>1048576)refuse(1,0,ENOTSUP);
  close_unrelated(descriptors);
  validate(header,(int)operation,selected,operation==1); reply(0,0,0,0);
  unsigned char go; read_all(&go,1); if(go!=0xa5)refuse(9,0,EPROTO);
  unsigned char extra; ssize_t n; do { n=read(STDIN_FILENO,&extra,1); }while(n<0&&errno==EINTR);
  if(n!=0)refuse(9,0,n<0?errno:EPROTO);
  alive(); validate(header,(int)operation,selected,operation==1);
  if(operation==1) {
    unsigned char buffer[33024]; memset(buffer,0,sizeof buffer);
    for(unsigned index=0;index<11;index++) {
      int fd=6+(int)index; alive(); fstore_t store={0}; store.fst_flags=F_ALLOCATEALL|F_ALLOCATEPERSIST;
      store.fst_posmode=F_PEOFPOSMODE; store.fst_offset=0; store.fst_length=(off_t)sizes[index];
      if(fcntl(fd,F_PREALLOCATE,&store))refuse(3,index+1,errno);
      alive(); if(ftruncate(fd,(off_t)sizes[index]))refuse(4,index+1,errno);
      size_t done=0; while(done<sizes[index]) { alive(); ssize_t written=pwrite(fd,buffer+done,sizes[index]-done,(off_t)done);
        if(written<0&&errno==EINTR)continue; if(written<=0)refuse(4,index+1,written<0?errno:EIO); done+=(size_t)written; }
      full_flush(fd,index+1); struct stat st=checked(fd,0,index+1); named(5,names[index],fd,0,index+1);
      if(st.st_size!=(off_t)sizes[index]||st.st_blocks<0||(uint64_t)st.st_blocks*512<sizes[index])refuse(8,index+1,EINVAL);
      unsigned char readback[33024]; done=0; while(done<sizes[index]) { ssize_t got=pread(fd,readback+done,sizes[index]-done,(off_t)done);
        if(got<0&&errno==EINTR)continue; if(got<=0)refuse(7,index+1,got<0?errno:EIO); done+=(size_t)got; }
      if(memcmp(buffer,readback,sizes[index]))refuse(7,index+1,EINVAL);
    }
    alive(); if(fsync(5))refuse(6,0,errno); full_flush(6,1);
  } else full_flush(6,selected);
  alive(); validate(header,(int)operation,selected,0);
  reply(1,0,0,0); return 0;
}
