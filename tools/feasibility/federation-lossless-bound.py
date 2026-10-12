# Exhaustive dynamic programming over representative UTF-16 unit classes.
# Development-only finite checker; no serializer or crypto implementation.
# Fixed DP limits bound work; no CLI argument can expand populations.
def h(n):return 1 if n<24 else 2 if n<256 else 3 if n<65536 else 5 if n<2**32 else 9
# (native processed bytes, current valid-run bytes, completed run size,
#  unpaired count, completed run count, pending high surrogate)
def append(st,t):
 n,r,s,u,k,p=st
 def lone(n,r,s,u,k):
  if r:s+=r+h(r);k+=1;r=0
  return n+3,r,s,u+1,k
 if p:
  if t=='L':return (n+4,r+4,s,u,k,False)
  n,r,s,u,k=lone(n,r,s,u,k)
 if t=='H':return n,r,s,u,k,True
 if t=='L':
  n,r,s,u,k=lone(n,r,s,u,k);return n,r,s,u,k,False
 b=int(t);return n+b,r+b,s,u,k,False

def finish(st):
 n,r,s,u,k,p=st
 if p:
  if r:s+=r+h(r);k+=1;r=0
  n+=3;u+=1
 if not u:return n,n+h(n),0
 if r:s+=r+h(r);k+=1
 return n,s+3*u+h(u+k),u+k

def dp(max_units,max_bytes):
 states={(0,0,0,0,0,False)};bybytes=[0]*(max_bytes+1);byunits=[0]*(max_units+1);statecount=0
 for units in range(max_units+1):
  statecount+=len(states)
  for st in states:
   n,size,elements=finish(st)
   if n<=max_bytes:bybytes[n]=max(bybytes[n],size);byunits[units]=max(byunits[units],size)
  if units<max_units:
   states={out for st in states for t in ['1','2','3','H','L'] if (out:=append(st,t))[0]+(3 if out[5] else 0)<=max_bytes}
 return bybytes,byunits,statecount
b,u,count=dp(12,12)
# Every category string up to12units/12native bytes is represented; equivalent
# structural states are merged, not sampled. Prefix maxima model <= budgets.
b=[max(b[:i+1]) for i in range(len(b))]
for B,value in enumerate(b):
 N=max([0]+[n for n in range(B+1) if (2*n-(n%2))<=B])
 bound=max(B+h(B),B+(B+3)//4+h(N))
 assert value<=bound,(B,value,bound)
# Independent UTF-16 unit-budget DP includes all native byte classes up to3K.
b2,u2,count2=dp(8,24)
u2=[max(u2[:i+1]) for i in range(len(u2))]
for K,value in enumerate(u2):
 bound=max(3*K+h(3*K),3*K+(K+1)//2+h(K))
 assert value<=bound,(K,value,bound)
print({'bodyBudgetExhaustiveMaxima0to12':b,'unitBudgetExhaustiveMaxima0to8':u2,'mergedStates':count+count2})
# Attaining witnesses, including corrected mixed-run metadata maxima.
body=8192*(2+3)+h(16384)
ref=128*(4+3)+h(256)
corr=64*(4+3)+h(128)
assert (body,ref,corr)==(40963,899,450)
P=1+34+body+(1+16*ref)+corr+corr+1
actual=P-corr+42
assert (P,actual)==(56284,55876)
for name,p in [('validated-shape',P),('actual-reply',actual)]:
 wire=p+663
 print(name,{'plaintext':p,'wire':wire,'relaySlots':268435456//wire,'routeSlots':33554432//wire,'localRelaySlots':67108864//wire})
assert 6+16384+16+16*256+128+128==20758
print({'bodyElements':16384,'referenceElementsEach':256,'correlationElements':128,'allPlaintextArrayElements':20758,'decodedNodesIncludingRoot':20759,'maxPlaintextDepth':3})
# Exact header transitions used by both mathematical bounds.
for n in [0,1,23,24,255,256,65535,65536]:print('CBORheader',n,h(n))
# Adversarial threshold cases; an ASCII run followed by one unpaired high.
for r in [23,24,255,256]:
 encoded=r+h(r)+3+h(2)
 assert encoded=={23:28,24:30,255:261,256:263}[r]
 print('run-header-threshold',{'runBytes':r,'nativeBytes':r+3,'encodedBytes':encoded})
for K in [23,24,127,128,255,256]:
 R=(K+1)//2;U=K//2
 encoded=3*K+R+h(K)
 print('unit-array-threshold',{'units':K,'runs':R,'unpaired':U,'encodedBytes':encoded})
print({'emptyTextBytes':1,'allLoneBodyAt32768Budget':3*(32768//3)+h(32768//3),'validPairTextBytes':4+h(4),'noncanonicalPairAsIntegersBytes':3+3+h(2)})
