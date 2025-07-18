import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import { Link, useLocation } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { LinkButton } from "./Buttons";

export function PaginationControls({
  currentPage,
  totalPages,
  showPageNumbers = true,
}: {
  currentPage: number;
  totalPages: number;
  showPageNumbers?: boolean;
}) {
  const location = useLocation();
  if (totalPages <= 1) {
    return null;
  }

  return (
    <nav className="flex items-center gap-1" aria-label="Pagination">
      {showPageNumbers ? (
        <>
          <LinkButton
            to={pageUrl(location, currentPage - 1)}
            variant="secondary/small"
            LeadingIcon={ChevronLeftIcon}
            shortcut={{ key: "j" }}
            tooltip="Previous"
            disabled={currentPage === 1}
            className={cn("px-2", currentPage > 1 ? "group" : "")}
          />

          {calculatePageLinks(currentPage, totalPages).map((page, i) => (
            <PageLinkComponent page={page} key={i} location={location} />
          ))}

          <LinkButton
            to={pageUrl(location, currentPage + 1)}
            variant="secondary/small"
            TrailingIcon={ChevronRightIcon}
            shortcut={{ key: "k" }}
            tooltip="Next"
            disabled={currentPage === totalPages}
            className={cn("px-2", currentPage !== totalPages ? "group" : "")}
          />
        </>
      ) : (
        <div className="flex items-center">
          <div className={cn("peer/prev order-1", currentPage === 1 && "pointer-events-none")}>
            <LinkButton
              to={pageUrl(location, currentPage - 1)}
              variant="secondary/small"
              LeadingIcon={ChevronLeftIcon}
              shortcut={{ key: "j" }}
              tooltip="Previous"
              disabled={currentPage === 1}
              className={cn(
                "flex items-center rounded-r-none border-r-0 pl-2 pr-[0.5625rem]",
                currentPage === 1 && "cursor-not-allowed opacity-50"
              )}
            />
          </div>

          <div
            className={cn(
              "order-2 h-6 w-px bg-charcoal-600 transition-colors peer-hover/next:bg-charcoal-550 peer-hover/prev:bg-charcoal-550",
              currentPage === 1 && currentPage === totalPages && "opacity-30"
            )}
          />

          <div
            className={cn("peer/next order-3", currentPage === totalPages && "pointer-events-none")}
          >
            <LinkButton
              to={pageUrl(location, currentPage + 1)}
              variant="secondary/small"
              TrailingIcon={ChevronRightIcon}
              shortcut={{ key: "k" }}
              tooltip="Next"
              disabled={currentPage === totalPages}
              className={cn(
                "flex items-center rounded-l-none border-l-0 pl-[0.5625rem] pr-2",
                currentPage === totalPages && "cursor-not-allowed opacity-50"
              )}
            />
          </div>
        </div>
      )}
    </nav>
  );
}

function pageUrl(location: ReturnType<typeof useLocation>, page: number): string {
  const search = new URLSearchParams(location.search);

  search.set("page", String(page));

  return location.pathname + "?" + search.toString();
}

const baseClass =
  "flex items-center justify-center border border-transparent min-w-6 h-6 px-1 text-xs font-medium transition text-text-dimmed rounded-sm focus-visible:focus-custom";
const unselectedClass = "hover:bg-tertiary hover:text-text-bright";
const selectedClass = "border-charcoal-600 bg-tertiary text-text-bright hover:bg-charcoal-600/50";

function PageLinkComponent({
  page,
  location,
}: {
  page: PageLink;
  location: ReturnType<typeof useLocation>;
}) {
  if (page.type === "specific") {
    return (
      <Link
        to={pageUrl(location, page.page)}
        className={cn(baseClass, page.isCurrent ? selectedClass : unselectedClass)}
      >
        {page.page}
      </Link>
    );
  } else {
    return <span className={baseClass}>...</span>;
  }
}

type PageLink = EllipsisPageLink | SpecificPageLink;

type EllipsisPageLink = {
  type: "ellipses";
};

type SpecificPageLink = {
  type: "specific";
  page: number;
  isCurrent: boolean;
};

// If there are less than or equal to 6 pages, just show all the pages.
// If there are more than 5 pages, show the first 3, the current page, and the last 3.
function calculatePageLinks(currentPage: number, totalPages: number): Array<PageLink> {
  const pageLinks: Array<PageLink> = [];

  if (totalPages <= 10) {
    for (let i = 1; i <= totalPages; i++) {
      pageLinks.push({
        type: "specific",
        page: i,
        isCurrent: i === currentPage,
      });
    }
  } else {
    if (currentPage <= 3) {
      for (let i = 1; i <= 4; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = totalPages - 3; i <= totalPages; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }
    } else if (currentPage >= totalPages - 3) {
      for (let i = 1; i <= 3; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = totalPages - 4; i <= totalPages; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }
    } else {
      for (let i = 1; i <= 3; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = currentPage - 1; i <= currentPage + 1; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = totalPages - 2; i <= totalPages; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }
    }
  }

  return pageLinks;
}
